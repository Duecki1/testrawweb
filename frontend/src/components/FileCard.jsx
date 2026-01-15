import { useState, useRef, useEffect } from 'react';
import { getPreviewUrl } from '../api';
import { getRotationTransform, getMasonryStyle } from '../utils';
import { Star, Check, ImageOff } from 'lucide-react';

export function FileCard({ file, isSelected, onSelect, onNavigate }) {
  const [status, setStatus] = useState('loading');
  const [dims, setDims] = useState({ w: 300, h: 200 });
  const [imgSrc, setImgSrc] = useState(() => getPreviewUrl(file.path, 'thumb'));
  const imgRef = useRef(null);
  const containerRef = useRef(null);

  // Calculate masonry box size
  const masonry = getMasonryStyle(dims.w, dims.h, file.orientation, 220);

  // Exact same math as DetailView, but using Math.max (Cover) instead of Min (Contain)
  // to prevent tiny gaps at the edges
  const fitImage = () => {
    const img = imgRef.current;
    const con = containerRef.current;
    if (!img || !con) return;

    // Wait for layout
    if (con.clientWidth === 0) return;

    const cw = con.clientWidth; 
    const ch = con.clientHeight;
    const iw = img.naturalWidth; 
    const ih = img.naturalHeight;
    if (!iw || !ih) return;

    const o = parseInt(file.orientation || "1", 10);
    const isRotated = [5,6,7,8].includes(o);
    const targetW = isRotated ? ih : iw;
    const targetH = isRotated ? iw : ih;

    // Use MAX to cover the box completely
    const scale = Math.max(cw / targetW, ch / targetH);

    img.style.width = `${iw}px`;
    img.style.height = `${ih}px`;
    img.style.transform = `translate(-50%, -50%) scale(${scale}) ${getRotationTransform(o)}`;
    img.style.opacity = 1;
  };

  const handleLoad = (e) => {
    if (e.target.naturalWidth > 0) {
      setDims({ w: e.target.naturalWidth, h: e.target.naturalHeight });
      setStatus('loaded');
      // Fit immediately
      requestAnimationFrame(fitImage);
    }
  };

  const handleError = () => {
    // Retry with full preview before giving up
    const thumbUrl = getPreviewUrl(file.path, 'thumb');
    if (imgSrc === thumbUrl) {
      setImgSrc(getPreviewUrl(file.path, 'full'));
      return;
    }
    setStatus('error');
  };

  useEffect(() => {
    setStatus('loading');
    setDims({ w: 300, h: 200 });
    setImgSrc(getPreviewUrl(file.path, 'thumb'));
  }, [file.path]);

  // Re-fit on resize or status change
  useEffect(() => {
    const observer = new ResizeObserver(() => fitImage());
    if (containerRef.current) observer.observe(containerRef.current);
    if (status === 'loaded') fitImage();
    return () => observer.disconnect();
  }, [status, dims]);

  return (
    <div 
      ref={containerRef}
      className={`file-card ${isSelected ? 'selected' : ''}`}
      onClick={() => onNavigate(file.path)}
      style={{
        height: '220px',
        position: 'relative',
        flexGrow: masonry.flexGrow,
        flexBasis: masonry.flexBasis,
        backgroundColor: '#111',
        overflow: 'hidden',
        outline: isSelected ? '2px solid white' : 'none',
        outlineOffset: '-2px',
        borderRadius: '4px'
      }}
    >
      <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
        {status === 'error' ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333' }}>
            <ImageOff size={48} />
          </div>
        ) : (
          <img
            ref={imgRef}
            src={imgSrc}
            onLoad={handleLoad}
            onError={handleError}
            alt={file.name}
            loading="lazy"
            style={{
              position: 'absolute',
              top: '50%', left: '50%',
              transformOrigin: 'center',
              opacity: 0,
              transition: 'opacity 0.2s ease-in'
            }}
          />
        )}
      </div>

      <div className="overlay" style={{
        position: 'absolute', inset: 0, padding: 8,
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.4), transparent, rgba(0,0,0,0.9))',
        opacity: isSelected ? 1 : 0, transition: 'opacity 0.2s',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between'
      }}
      onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
      onMouseLeave={(e) => !isSelected && (e.currentTarget.style.opacity = 0)}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <button 
            onClick={(e) => { e.stopPropagation(); onSelect(file.path); }}
            style={{ 
              width: 20, height: 20, padding: 0, borderRadius: '50%', 
              background: isSelected ? 'white' : 'rgba(0,0,0,0.5)', 
              borderColor: isSelected ? 'white' : 'white',
              color: 'black', display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
          >
            {isSelected && <Check size={12} strokeWidth={4} />}
          </button>
          
          <div style={{ display: 'flex', gap: 2 }}>
            {[1,2,3,4,5].map(star => (
              <Star key={star} size={12} 
                fill={(file.user_rating || 0) >= star ? "white" : "transparent"} 
                stroke={ (file.user_rating || 0) >= star ? "white" : "rgba(255,255,255,0.3)"} 
              />
            ))}
          </div>
        </div>
        <div style={{ color: 'white', fontSize: '0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {file.name}
        </div>
      </div>
    </div>
  );
}