import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  video: HTMLVideoElement;
  onPoint: (x: number, y: number) => void;
  onZoom?: (direction: number) => void;
  onLeave: () => void;
  onExit: () => void;
}

export function PtzAimSurface({ video, onPoint, onZoom, onLeave, onExit }: Props) {
  const surface = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const scale = Math.min(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight);
      const width = Number.isFinite(scale) ? video.videoWidth * scale : 0;
      const height = Number.isFinite(scale) ? video.videoHeight * scale : 0;
      setSize(last => last.width === width && last.height === height ? last : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    video.addEventListener('resize', measure);
    video.addEventListener('loadedmetadata', measure);
    return () => {
      observer.disconnect();
      video.removeEventListener('resize', measure);
      video.removeEventListener('loadedmetadata', measure);
    };
  }, [video]);
  useEffect(() => {
    const element = surface.current;
    if (!element || !onZoom) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      e.stopPropagation();
      if (video.readyState >= 2) onZoom(-Math.sign(e.deltaY));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [video, onZoom, size]);
  if (!video.parentElement || !size.width || !size.height) return null;
  return createPortal(
    <button type="button" ref={surface} aria-label="选择要居中的画面位置"
      className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 cursor-crosshair touch-none"
      style={size} onPointerLeave={onLeave} onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); onExit(); }
      }}
      onClick={e => {
        e.stopPropagation();
        if (!e.detail || video.readyState < 2) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = 2 * (e.clientX - rect.left) / rect.width - 1;
        const y = 1 - 2 * (e.clientY - rect.top) / rect.height;
        if (Math.abs(x) <= 1 && Math.abs(y) <= 1 && Math.hypot(x, y) > 0.02) onPoint(x, y);
      }} />,
    video.parentElement,
  );
}
