import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, getPreviewUrl, getDownloadUrl, formatBytes } from '../api';
import { getRotationTransform } from '../utils';
import { ChevronLeft, ChevronRight, Star, Download, ArrowLeft } from 'lucide-react';

export function DetailView({ path, onClose }) {
  const [meta, setMeta] = useState(null);
  const [tagOptions, setTagOptions] = useState([]);
  const [tagInput, setTagInput] = useState("");
  
  const imgRef = useRef(null);
  const containerRef = useRef(null);
  
  const [siblings, setSiblings] = useState({ prev: null, next: null, pos: "" });
  const [, setLocation] = useLocation();

  // Load Data
  useEffect(() => {
    loadData();
    const handleKey = (e) => {
      if(e.target.tagName === 'INPUT') return;
      if(e.key === "ArrowLeft" && siblings.prev) setLocation(`/?path=${encodeURIComponent(siblings.prev)}&view=detail`);
      if(e.key === "ArrowRight" && siblings.next) setLocation(`/?path=${encodeURIComponent(siblings.next)}&view=detail`);
      if(e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [path, siblings.prev, siblings.next]); // Added deps to prevent stale closures

  // Handle Resize Logic
  useEffect(() => {
    // This observer fires whenever the container size changes (e.g. window resize)
    const observer = new ResizeObserver(() => fitImage());
    if (containerRef.current) observer.observe(containerRef.current);
    
    // Also try to fit immediately in case image is cached
    if (imgRef.current && imgRef.current.complete) fitImage();

    return () => observer.disconnect();
  }, [meta]); // Re-bind when meta loads

  const loadData = async () => {
    try {
      const m = await api.get(`/api/file/metadata?path=${encodeURIComponent(path)}`);
      setMeta(m);
      
      const folder = path.substring(0, path.lastIndexOf('/'));
      const browse = await api.get(`/api/browse?path=${encodeURIComponent(folder)}`);
      const files = browse.entries.filter(e => e.kind === 'file');
      const idx = files.findIndex(e => e.path === path);
      
      setSiblings({
        prev: idx > 0 ? files[idx - 1].path : null,
        next: idx < files.length - 1 ? files[idx + 1].path : null,
        pos: `${idx + 1} / ${files.length}`
      });

      const tags = await api.get('/api/tags');
      setTagOptions(tags.tags || []);
    } catch (e) { console.error(e); }
  };

  const fitImage = () => {
    if (!imgRef.current || !containerRef.current || !meta) return;
    const img = imgRef.current;
    const con = containerRef.current;
    
    // If container hasn't sized yet, abort
    if (con.clientWidth === 0 || con.clientHeight === 0) return;

    const cw = con.clientWidth; 
    const ch = con.clientHeight;
    const iw = img.naturalWidth; 
    const ih = img.naturalHeight;
    
    if (!iw || !ih) return;

    const o = parseInt(meta.orientation || "1", 10);
    const isRotated = [5,6,7,8].includes(o);
    
    // The visual dimensions the image WANTS to occupy
    const targetW = isRotated ? ih : iw;
    const targetH = isRotated ? iw : ih;
    
    // Contain logic
    const scale = Math.min(cw / targetW, ch / targetH);

    img.style.width = `${iw}px`;
    img.style.height = `${ih}px`;
    
    // Important: transform-origin center centers the scaling
    img.style.transform = `translate(-50%, -50%) scale(${scale}) ${getRotationTransform(o)}`;
    img.style.opacity = 1;
  };

  const handleRate = async (rating) => {
    const newR = meta.user_rating === rating ? null : rating;
    await api.post('/api/file/rating', { path, rating: newR });
    setMeta({ ...meta, user_rating: newR });
  };

  const handleAddTag = async () => {
    if (!tagInput) return;
    const newTags = [...(meta.tags || [])];
    if (!newTags.includes(tagInput)) {
      newTags.push(tagInput);
      await api.post('/api/file/tags', { path, tags: newTags });
      setMeta({ ...meta, tags: newTags });
      const t = await api.get('/api/tags');
      setTagOptions(t.tags);
    }
    setTagInput("");
  };

  const removeTag = async (tag) => {
    const newTags = meta.tags.filter(t => t !== tag);
    await api.post('/api/file/tags', { path, tags: newTags });
    setMeta({ ...meta, tags: newTags });
  };

  if (!meta) return <div style={{color:'#777', padding: 40}}>Loading...</div>;

 return (
  <div style={{ 
    display: 'flex', 
    width: '100vw',    // Viewport Width
    height: '100vh',   // Viewport Height
    position: 'fixed', // Force it to sit on top
    top: 0, 
    left: 0, 
    zIndex: 50,
    background: '#000' 
  }}>
      {/* Image Area */}
      <div ref={containerRef} style={{ flex: 1, background: 'black', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: 16, display: 'flex', justifyContent: 'space-between', zIndex: 10, background: 'linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)' }}>
          <button onClick={onClose}><ArrowLeft size={16}/> Back</button>
          <div style={{ color: 'white' }}>{meta.name} ({siblings.pos})</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button disabled={!siblings.prev} onClick={() => setLocation(`/?path=${encodeURIComponent(siblings.prev)}&view=detail`)}><ChevronLeft size={16}/> Prev</button>
            <button disabled={!siblings.next} onClick={() => setLocation(`/?path=${encodeURIComponent(siblings.next)}&view=detail`)}><ChevronRight size={16}/> Next</button>
          </div>
        </div>
        
        <img 
          ref={imgRef}
          src={getPreviewUrl(path, 'full')} 
          onLoad={fitImage}
          alt={meta.name}
          style={{ 
            position: 'absolute', 
            top: '50%', left: '50%', 
            opacity: 0, // Hidden until fitImage runs
            transition: 'opacity 0.2s', 
            transformOrigin: 'center' 
          }}
        />
      </div>

      {/* Sidebar */}
      <div style={{ width: 300, background: '#0a0a0a', borderLeft: '1px solid #222', padding: 20, display: 'flex', flexDirection: 'column', gap: 24, overflowY: 'auto' }}>
        <div>
          <div className="meta-label" style={{fontSize: '0.7rem', color:'#777', marginBottom: 6}}>RATING</div>
          <div style={{display:'flex', gap:4}}>
            {[1,2,3,4,5].map(i => (
              <button key={i} onClick={() => handleRate(i)} style={{border:'none', background:'transparent', fontSize:'1.5rem', padding:0, color: (meta.user_rating||0)>=i ? 'white' : '#333'}}>★</button>
            ))}
          </div>
        </div>

        <div>
          <div className="meta-label" style={{fontSize: '0.7rem', color:'#777', marginBottom: 6}}>TAGS</div>
          <div style={{display:'flex', flexWrap:'wrap', gap:6, marginBottom: 8}}>
            {(meta.tags || []).map(t => (
              <span key={t} style={{background:'#1a1a1a', padding:'4px 8px', borderRadius: 99, fontSize:'0.75rem', display:'flex', alignItems:'center', gap:4}}>
                {t} <button onClick={()=>removeTag(t)} style={{border:'none', padding:0, color:'#777'}}>×</button>
              </span>
            ))}
          </div>
          <div style={{display:'flex', gap:4}}>
            <input className="input" list="tag-opts" value={tagInput} onChange={e=>setTagInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleAddTag()} placeholder="Add tag..." />
            <button className="primary-btn" onClick={handleAddTag}>+</button>
            <datalist id="tag-opts">{tagOptions.map(t=><option key={t} value={t} />)}</datalist>
          </div>
        </div>

        <div>
           <div className="meta-label" style={{fontSize: '0.7rem', color:'#777', marginBottom: 6}}>INFO</div>
           <div style={{marginBottom:4}}>{formatBytes(meta.file_size)}</div>
           <div style={{marginBottom:4}}>{meta.taken_at || "Unknown Date"}</div>
           <div style={{color: meta.gps_lat ? 'white' : '#444'}}>{meta.gps_lat ? "Has Location Data" : "No Location"}</div>
        </div>

        <a href={getDownloadUrl(path)} className="primary-btn" style={{textDecoration:'none'}}>
          <Download size={16} /> Download Raw
        </a>
      </div>
    </div>
  );
}