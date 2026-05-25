import { useCallback, useRef, useEffect, useState } from "react";

type Direction = "horizontal" | "vertical";

export default function ResizeHandle({
  direction,
  onResize,
}: {
  direction: Direction;
  onResize: (delta: number) => void;
}) {
  const isDragging = useRef(false);
  const lastPos = useRef(0);
  const [active, setActive] = useState(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;
      setActive(true);
    },
    [direction]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const currentPos = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = currentPos - lastPos.current;
      if (delta !== 0) {
        onResize(delta);
        lastPos.current = currentPos;
      }
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      setActive(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [direction, onResize]);

  const isH = direction === "horizontal";

  return (
    <div
      className={`resize-handle ${isH ? "resize-h" : "resize-v"} ${active ? "active" : ""}`}
      onMouseDown={handleMouseDown}
      style={{
        width: isH ? 5 : "100%",
        height: isH ? "100%" : 5,
        cursor: isH ? "col-resize" : "row-resize",
        flexShrink: 0,
      }}
    />
  );
}
