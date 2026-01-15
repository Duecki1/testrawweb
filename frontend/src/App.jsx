import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { api } from './api';
import { FileCard } from './components/FileCard';
import { DetailView } from './components/DetailView';
import { Folder, HardDrive, CheckSquare, Trash2, FolderPlus } from 'lucide-react';

export default function App() {
  const [location, setLocation] = useLocation();
  const searchStr = useSearch();
  const params = new URLSearchParams(searchStr);
  const currentPath = params.get("path") || "";
  const viewMode = params.get("view"); // 'detail' or null

  const [entries, setEntries] = useState([]);
  const [selection, setSelection] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    api.get('/api/config').then(setConfig).catch(console.error);
  }, []);

  useEffect(() => {
    if (viewMode === 'detail') return; // Don't fetch if in detail mode (Detail component handles it)
    setLoading(true);
    api.get(`/api/browse?path=${encodeURIComponent(currentPath)}`)
      .then(data => {
        setEntries(data.entries);
        setSelection(new Set());
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [currentPath, viewMode]);

  const toggleSelect = (path) => {
    const newSet = new Set(selection);
    if (newSet.has(path)) newSet.delete(path);
    else newSet.add(path);
    setSelection(newSet);
  };

  const handleSelectAll = () => {
    const newSet = new Set();
    entries.forEach(e => newSet.add(e.path));
    setSelection(newSet);
  };

  // Breadcrumbs
  const crumbs = currentPath ? currentPath.split('/') : [];
  
  // Render
  if (!config) return <div style={{padding:20, color:'#777'}}>Connecting...</div>;
  if (!config.configured) return <div style={{padding:20}}>Library not configured. Check .env</div>;

  // Detail View Overlay
  if (viewMode === 'detail') {
    return <DetailView path={currentPath} onClose={() => setLocation(currentPath.includes('/') ? `/?path=${encodeURIComponent(currentPath.split('/').slice(0,-1).join('/'))}` : `/`)} />;
  }

  // Explorer View
  const dirs = entries.filter(e => e.kind === 'dir');
  const files = entries.filter(e => e.kind === 'file');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top Bar */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #222', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 600 }}>Raw Manager</div>
        <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#777' }}>{config.library_root}</div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Sidebar */}
        <div style={{ width: 250, background: '#0a0a0a', borderRight: '1px solid #222', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 16, fontSize: '0.8rem', color: '#777', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
             <button onClick={() => setLocation('/')} style={{border:'none', padding:0, textDecoration:'underline'}}>Lib</button>
             {crumbs.map((c, i) => (
               <span key={i}> / <button onClick={() => setLocation(`/?path=${encodeURIComponent(crumbs.slice(0, i+1).join('/'))}`)} style={{border:'none', padding:0, textDecoration:'underline'}}>{c}</button></span>
             ))}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {dirs.map(dir => (
               <div key={dir.path} onClick={() => setLocation(`/?path=${encodeURIComponent(dir.path)}`)} 
                    style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, color: '#777' }}
                    onMouseEnter={e=>e.currentTarget.style.color='#eee'}
                    onMouseLeave={e=>e.currentTarget.style.color='#777'}
               >
                 <Folder size={14} /> {dir.name}
               </div>
            ))}
          </div>
        </div>

        {/* Main Grid */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'black' }}>
          <div style={{ padding: '12px 16px', background: 'rgba(0,0,0,0.9)', borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', gap: 10, zIndex: 5 }}>
             <span style={{ color: '#777', fontFamily: 'monospace', fontSize: '0.8rem', marginRight: 'auto' }}>{selection.size} selected</span>
             <button onClick={handleSelectAll}><CheckSquare size={14}/> All</button>
             <button disabled={!selection.size}><FolderPlus size={14}/> Move</button>
             <button disabled={!selection.size}><Trash2 size={14}/> Delete</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 4, padding: 4 }}>
            {loading && <div style={{padding:20, color:'#777'}}>Loading...</div>}
            
            {!loading && files.map(file => (
              <FileCard 
                key={file.path} 
                file={file} 
                isSelected={selection.has(file.path)} 
                onSelect={toggleSelect}
                onNavigate={(path) => setLocation(`/?path=${encodeURIComponent(path)}&view=detail`)}
              />
            ))}
            
            {/* Spacer to keep flex layout nice */}
            <div style={{ flexGrow: 99999 }}></div>
          </div>
        </div>
      </div>
    </div>
  );
}
