const API = 'http://localhost:3000/api';
const BASE = 'http://localhost:3000';

export async function fetchMedia({ type, search, limit = 200 } = {}) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (search) params.set('search', search);
  params.set('limit', limit);
  const res = await fetch(`${API}/media?${params}`);
  return res.json();
}

export async function fetchMediaAnalysis(id) {
  const res = await fetch(`${API}/media/${id}/analysis`);
  if (!res.ok) return null;
  return res.json();
}

export async function searchByTags(q, lang) {
  const params = new URLSearchParams({ q });
  if (lang) params.set('lang', lang);
  const res = await fetch(`${API}/media/search/tags?${params}`);
  return res.json();
}

export async function fetchProjects() {
  const res = await fetch(`${API}/projects`);
  return res.json();
}

export async function fetchProject(id) {
  const res = await fetch(`${API}/projects/${id}`);
  return res.json();
}

export async function startRender(projectId) {
  const res = await fetch(`${API}/projects/${projectId}/render`, { method: 'POST' });
  return res.json();
}

export async function fetchRenderStatus(projectId) {
  const res = await fetch(`${API}/projects/${projectId}/render/status`);
  return res.json();
}

export function thumbnailUrl(filename) {
  return `${BASE}/thumbnails/${filename}`;
}

export function outputUrl(path) {
  return `${BASE}${path}`;
}
