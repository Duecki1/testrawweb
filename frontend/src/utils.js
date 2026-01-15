export function getRotationTransform(orientation) {
  const o = parseInt(orientation || "1", 10);
  if (o <= 1) return "";
  
  switch (o) {
    case 2: return "scaleX(-1)";
    case 3: return "rotate(180deg)";
    case 4: return "scaleY(-1)";
    case 5: return "rotate(90deg) scaleX(-1)";
    case 6: return "rotate(90deg)";
    case 7: return "rotate(270deg) scaleX(-1)";
    case 8: return "rotate(270deg)";
    default: return "";
  }
}

export function getMasonryStyle(imgWidth, imgHeight, orientation, rowHeight) {
  // FALLBACK: If dimensions are missing, assume standard 3:2 landscape
  const safeW = imgWidth || 300;
  const safeH = imgHeight || 200;

  const o = parseInt(orientation || "1", 10);
  const isRotated = [5, 6, 7, 8].includes(o);

  // If rotated, swap dimensions for ratio calc
  const w = isRotated ? safeH : safeW;
  const h = isRotated ? safeW : safeH;
  const ratio = w / h;
  const width = Math.floor(rowHeight * ratio);

  return {
    flexGrow: ratio,
    flexBasis: `${width}px`,
    // If rotated, we force the img tag to swap dimensions visually so object-fit works
    imgStyle: isRotated ? { width: `${rowHeight}px`, height: `${width}px` } : { width: '100%', height: '100%' }
  };
}