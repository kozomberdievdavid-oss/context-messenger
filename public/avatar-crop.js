/** Telegram-style avatar crop editor */
const AvatarCrop = (() => {
  let img = null;
  let scale = 1;
  let rotation = 0;
  let flipX = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let dragStart = { x: 0, y: 0 };
  let onConfirmCallback = null;

  const MAX_OUT = 512;
  const JPEG_QUALITY = 0.88;

  function $(id) {
    return document.getElementById(id);
  }

  function open(file, onConfirm) {
    if (!file || !file.type.startsWith('image/')) return;
    onConfirmCallback = onConfirm;
    scale = 1;
    rotation = 0;
    flipX = 1;
    offsetX = 0;
    offsetY = 0;

    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        img = image;
        fitInitialScale();
        $('avatar-crop-modal')?.classList.remove('hidden');
        drawPreview();
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function close() {
    $('avatar-crop-modal')?.classList.add('hidden');
    img = null;
    onConfirmCallback = null;
  }

  function fitInitialScale() {
    if (!img) return;
    const size = Math.min(window.innerWidth, window.innerHeight) * 0.72;
    const minDim = Math.min(img.width, img.height);
    scale = size / minDim;
    offsetX = 0;
    offsetY = 0;
  }

  function drawPreview() {
    const canvas = $('avatar-crop-canvas');
    if (!canvas || !img) return;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.min(window.innerWidth, window.innerHeight) * 0.72;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2 + offsetX, size / 2 + offsetY);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(scale * flipX, scale);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    ctx.restore();
  }

  function rotate() {
    rotation = (rotation + 90) % 360;
    drawPreview();
  }

  function flip() {
    flipX *= -1;
    drawPreview();
  }

  function pointerDown(e) {
    dragging = true;
    const p = e.touches ? e.touches[0] : e;
    dragStart = { x: p.clientX - offsetX, y: p.clientY - offsetY };
  }

  function pointerMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const p = e.touches ? e.touches[0] : e;
    offsetX = p.clientX - dragStart.x;
    offsetY = p.clientY - dragStart.y;
    drawPreview();
  }

  function pointerUp() {
    dragging = false;
  }

  function exportBlob() {
    return new Promise((resolve) => {
      const canvas = $('avatar-crop-canvas');
      if (!canvas || !img) return resolve(null);
      const size = Math.min(window.innerWidth, window.innerHeight) * 0.72;
      const out = document.createElement('canvas');
      out.width = MAX_OUT;
      out.height = MAX_OUT;
      const ctx = out.getContext('2d');
      ctx.beginPath();
      ctx.arc(MAX_OUT / 2, MAX_OUT / 2, MAX_OUT / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      const ratio = MAX_OUT / size;
      ctx.save();
      ctx.translate(MAX_OUT / 2 + offsetX * ratio, MAX_OUT / 2 + offsetY * ratio);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.scale(scale * flipX * ratio, scale * ratio);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      ctx.restore();
      out.toBlob(
        (blob) => resolve(blob),
        'image/jpeg',
        JPEG_QUALITY
      );
    });
  }

  async function confirm() {
    const blob = await exportBlob();
    close();
    if (blob && onConfirmCallback) onConfirmCallback(blob);
  }

  function bind() {
    const canvas = $('avatar-crop-canvas');
    if (!canvas) return;
    canvas.addEventListener('mousedown', pointerDown);
    canvas.addEventListener('mousemove', pointerMove);
    canvas.addEventListener('mouseup', pointerUp);
    canvas.addEventListener('mouseleave', pointerUp);
    canvas.addEventListener('touchstart', pointerDown, { passive: false });
    canvas.addEventListener('touchmove', pointerMove, { passive: false });
    canvas.addEventListener('touchend', pointerUp);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      scale *= e.deltaY > 0 ? 0.92 : 1.08;
      scale = Math.max(0.2, Math.min(scale, 8));
      drawPreview();
    }, { passive: false });
  }

  document.addEventListener('DOMContentLoaded', bind);

  return { open, close, rotate, flip, confirm };
})();

function avatarCropRotate() {
  AvatarCrop.rotate();
}
function avatarCropFlip() {
  AvatarCrop.flip();
}
function avatarCropConfirm() {
  AvatarCrop.confirm();
}
function avatarCropCancel() {
  AvatarCrop.close();
}
