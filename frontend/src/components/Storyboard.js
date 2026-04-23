import { thumbnailUrl } from '../hooks/useApi';

const MOVEMENT_LABELS = {
  zoom_in_center: '⊕ Zoom Center',
  zoom_in_person: '⊕ Zoom Person',
  pan_left_to_right: '→ Pan L→R',
  pan_right_to_left: '← Pan R→L',
  zoom_out: '⊖ Zoom Out',
  dramatic_push: '⚡ Dramatic',
};

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function Storyboard({ scenes }) {
  if (!scenes || scenes.length === 0) {
    return (
      <div className="panel storyboard">
        <div className="panel-header">
          <h2>Раскадровка</h2>
        </div>
        <div className="empty-state">
          <div className="empty-icon">🎬</div>
          <p>Загрузите аудио через API для создания раскадровки</p>
          <code>POST /api/projects/create-from-audio</code>
        </div>
      </div>
    );
  }

  return (
    <div className="panel storyboard">
      <div className="panel-header">
        <h2>Раскадровка</h2>
        <span className="stat">{scenes.length} сцен</span>
      </div>

      <div className="scenes-list">
        {scenes.map((scene, i) => (
          <div key={i} className="scene-card">
            <div className="scene-header">
              <span className="scene-number">#{scene.scene_number || i + 1}</span>
              <span className="scene-timecode">
                {formatTime(scene.start_time)} — {formatTime(scene.end_time)}
              </span>
              <span className="scene-duration">
                {(scene.end_time - scene.start_time).toFixed(1)}s
              </span>
            </div>

            <div className="scene-body">
              <div className="scene-thumb">
                {scene.selected_photo?.thumbnail ? (
                  <img
                    src={thumbnailUrl(scene.selected_photo.thumbnail)}
                    alt={scene.selected_photo.filename}
                  />
                ) : (
                  <div className="no-thumb">Нет фото</div>
                )}
                {scene.movement && (
                  <div className="kb-badge">
                    {MOVEMENT_LABELS[scene.movement] || scene.movement}
                  </div>
                )}
              </div>

              <div className="scene-text">
                <div className="narration">{scene.narration}</div>
                {scene.visual_description && (
                  <div className="visual-desc">{scene.visual_description}</div>
                )}
              </div>
            </div>

            {scene.matched_photos?.length > 1 && (
              <div className="alt-photos">
                {scene.matched_photos.slice(1, 4).map((ph, j) => (
                  <div key={j} className="alt-thumb" title={ph.description || ph.filename}>
                    {ph.thumbnail ? (
                      <img src={thumbnailUrl(ph.thumbnail)} alt="" />
                    ) : (
                      <div className="no-thumb-sm">alt</div>
                    )}
                    <span className="alt-score">{ph.score}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
