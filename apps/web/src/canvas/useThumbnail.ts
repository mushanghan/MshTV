import { useEffect, useState } from 'react';
const cache = new Map<string, HTMLImageElement>();
export const THUMBNAIL_CACHE_LIMIT = 80;
interface ImageJob {
  url: string;
  cacheImage: boolean;
  listeners: Set<(image: HTMLImageElement) => void>;
  image?: HTMLImageElement;
}
const jobs = new Map<string, ImageJob>(), waiting = new Set<ImageJob>();
let active = 0;

function finish(job: ImageJob, loaded: boolean) {
  if (jobs.get(job.url) !== job) return;
  const image = job.image!;
  image.onload = null;
  image.onerror = null;
  jobs.delete(job.url);
  active--;
  if (loaded) {
    if (job.cacheImage) {
      cache.set(job.url, image);
      if (cache.size > THUMBNAIL_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    }
    job.listeners.forEach(listener => listener(image));
  }
  job.listeners.clear();
  drain();
}

function drain() {
  while (active < 6 && waiting.size) {
    const job = waiting.values().next().value!;
    waiting.delete(job);
    active++;
    const image = job.image = new Image();
    image.onload = () => finish(job, true);
    image.onerror = () => finish(job, false);
    image.src = job.url;
  }
}

export function useThumbnail(url?: string, cacheImage = true) {
  const [loaded, setLoaded] = useState<{ url: string; image: HTMLImageElement }>();
  useEffect(() => {
    setLoaded(undefined); if (!url) return;
    const hit = cache.get(url); if (hit) { cache.delete(url); cache.set(url, hit); setLoaded({ url, image: hit }); return; }
    let job = jobs.get(url);
    if (!job) {
      job = { url, cacheImage, listeners: new Set() };
      jobs.set(url, job);
      waiting.add(job);
    }
    const listener = (image: HTMLImageElement) => setLoaded({ url, image });
    job.listeners.add(listener);
    drain();
    return () => {
      job.listeners.delete(listener);
      if (job.listeners.size || jobs.get(url) !== job) return;
      if (job.image) {
        job.image.removeAttribute('src');
        finish(job, false);
      } else {
        waiting.delete(job);
        jobs.delete(url);
      }
    };
  }, [url, cacheImage]);
  return loaded?.url === url ? loaded?.image : undefined;
}
