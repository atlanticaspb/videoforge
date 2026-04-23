import { useState } from 'react';
import MediaLibrary from './components/MediaLibrary';
import Storyboard from './components/Storyboard';
import ProjectPanel from './components/ProjectPanel';
import './App.css';

export default function App() {
  const [scenes, setScenes] = useState([]);
  const [, setSelectedPhoto] = useState(null);

  const handleProjectLoad = (project) => {
    if (project.storyboard) {
      const sb = typeof project.storyboard === 'string'
        ? JSON.parse(project.storyboard)
        : project.storyboard;
      setScenes(sb);
    } else {
      setScenes([]);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">VideoForge</div>
        <div className="subtitle">AI-Powered Historical Film Production</div>
      </header>
      <main className="workspace">
        <MediaLibrary onSelectPhoto={setSelectedPhoto} />
        <Storyboard scenes={scenes} />
        <ProjectPanel onProjectLoad={handleProjectLoad} />
      </main>
    </div>
  );
}
