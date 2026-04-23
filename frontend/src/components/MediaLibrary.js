import { useState, useEffect, useCallback } from 'react';
import { fetchMedia, searchByTags, thumbnailUrl, fetchMediaAnalysis } from '../hooks/useApi';

export default function MediaLibrary({ onSelectPhoto }) {
  const [media, setMedia] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [analysis, setAnalysis] = useState(null);

  const load = useCallback(async () => {
    let data;
    if (search.trim()) {
      data = await searchByTags(search.trim(), 'ru');
      setMedia(data.data || []);
      setTotal(data.total || 0);
    } else {
      data = await fetchMedia({ limit: 300 });
      setMedia(data.data || []);
      setTotal(data.total || 0);
    }
  }, [search]);

  useEffect(() => { load(); }, [load]);


  const handleClick = async (item) => {
    setSelectedId(item.id);
    onSelectPhoto?.(item);
    const a = await fetchMediaAnalysis(item.id);
    setAnalysis(a);
  };

  return (
    <div className="panel media-library">
      <div className="panel-header">
        <h2>Медиатека</h2>
        <div className="stats">
          <span className="stat">{total} фото</span>
        </div>
      </div>

      <div className="search-box">
        <input
          type="text"
          placeholder="Поиск по тегам: танк, Сталин, ВОВ..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="media-grid">
        {media.map(item => (
          <div
            key={item.id}
            className={`media-card ${selectedId === item.id ? 'selected' : ''}`}
            onClick={() => handleClick(item)}
          >
            {item.thumbnail ? (
              <img src={thumbnailUrl(item.thumbnail)} alt={item.filename} loading="lazy" />
            ) : (
              <div className="no-thumb">{item.type}</div>
            )}
            <div className="media-name">{item.filename.replace(/^[^_]+_/, '').slice(0, 25)}</div>
          </div>
        ))}
        {media.length === 0 && <div className="empty">Нет результатов</div>}
      </div>

      {analysis && (
        <div className="analysis-preview">
          <div className="analysis-field">
            <span className="label">Период:</span> {analysis.historical_period || '—'}
          </div>
          <div className="analysis-field">
            <span className="label">Год:</span> {analysis.year_estimate || '—'}
          </div>
          <div className="analysis-field">
            <span className="label">Тип:</span> {analysis.document_type || '—'}
          </div>
          {analysis.persons?.length > 0 && (
            <div className="analysis-field">
              <span className="label">Персоны:</span>{' '}
              {analysis.persons.map(p => p.name).filter(Boolean).join(', ')}
            </div>
          )}
          {analysis.tags?.ru?.length > 0 && (
            <div className="tags-list">
              {analysis.tags.ru.slice(0, 8).map((tag, i) => (
                <span key={i} className="tag" onClick={() => setSearch(tag)}>{tag}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
