import { useState, useEffect, useRef } from 'react';
import { fetchProjects, fetchProject, startRender, fetchRenderStatus, outputUrl } from '../hooks/useApi';

const STYLES = [
  { id: 'chronicle', label: 'Хроника', desc: 'Сепия, зерно, царапины' },
  { id: 'documentary', label: 'Документальный', desc: 'Лёгкое зерно, виньетка' },
  { id: 'dramatic', label: 'Драматический', desc: 'Film burn, тряска' },
  { id: 'archive', label: 'Архив', desc: 'Деградация, обратный отсчёт' },
];

export default function ProjectPanel({ onProjectLoad }) {
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [renderStatus, setRenderStatus] = useState(null);
  const [rendering, setRendering] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    fetchProjects().then(d => setProjects(d.data || []));
  }, []);

  // Stop polling on unmount
  useEffect(() => () => clearInterval(pollRef.current), []);

  const loadProject = async (id) => {
    const p = await fetchProject(id);
    setActiveProject(p);
    onProjectLoad?.(p);

    if (p.status === 'rendering') {
      startPolling(id);
    } else if (p.status === 'done') {
      const status = await fetchRenderStatus(id);
      setRenderStatus(status);
    }
  };

  const startPolling = (id) => {
    setRendering(true);
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const status = await fetchRenderStatus(id);
      setRenderStatus(status);
      if (status.status === 'done' || status.status === 'error') {
        clearInterval(pollRef.current);
        setRendering(false);
        setActiveProject(prev => prev ? { ...prev, status: status.status } : prev);
      }
    }, 3000);
  };

  const handleRender = async () => {
    if (!activeProject) return;
    await startRender(activeProject.id);
    setActiveProject(prev => ({ ...prev, status: 'rendering' }));
    setRenderStatus(null);
    startPolling(activeProject.id);
  };

  return (
    <div className="panel project-panel">
      <div className="panel-header">
        <h2>Проект</h2>
      </div>

      {/* Project list */}
      <div className="project-list">
        {projects.map(p => (
          <div
            key={p.id}
            className={`project-item ${activeProject?.id === p.id ? 'active' : ''}`}
            onClick={() => loadProject(p.id)}
          >
            <div className="project-name">{p.name}</div>
            <div className="project-meta">
              <span className={`status-badge status-${p.status}`}>{p.status}</span>
              {p.style && <span className="style-badge">{p.style}</span>}
            </div>
          </div>
        ))}
        {projects.length === 0 && <div className="empty">Нет проектов</div>}
      </div>

      {/* Active project details */}
      {activeProject && (
        <div className="project-details">
          <h3>{activeProject.name}</h3>

          {/* Style selector (read-only for now) */}
          <div className="style-selector">
            <label>Стиль:</label>
            <div className="style-options">
              {STYLES.map(s => (
                <div
                  key={s.id}
                  className={`style-option ${activeProject.style === s.id ? 'active' : ''}`}
                >
                  <div className="style-name">{s.label}</div>
                  <div className="style-desc">{s.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Render button */}
          <div className="render-section">
            {activeProject.status === 'rendering' || rendering ? (
              <div className="render-progress">
                <div className="progress-bar">
                  <div className="progress-fill" />
                </div>
                <span className="progress-text">Рендеринг...</span>
              </div>
            ) : activeProject.status === 'done' && renderStatus?.output ? (
              <div className="render-done">
                <a
                  href={outputUrl(renderStatus.output.path)}
                  className="download-btn"
                  target="_blank"
                  rel="noreferrer"
                >
                  Скачать MP4 ({(renderStatus.output.size_bytes / 1024 / 1024).toFixed(1)} MB)
                </a>
              </div>
            ) : (
              <button
                className="render-btn"
                onClick={handleRender}
                disabled={!activeProject.storyboard}
              >
                Рендер
              </button>
            )}

            {activeProject.status === 'error' && renderStatus?.description && (
              <div className="render-error">{renderStatus.description}</div>
            )}
          </div>

          {/* Transcription */}
          {activeProject.transcription && (
            <div className="transcription-box">
              <label>Транскрипция:</label>
              <p>{activeProject.transcription}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
