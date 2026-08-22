"use client";

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

type MatchMedia = (query: string) => MediaQueryList;

export function observeReducedMotion(matchMedia: MatchMedia, onChange: (reduced: boolean) => void): () => void {
  const media = matchMedia(QUERY);
  const update = () => onChange(media.matches);
  update();
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    return observeReducedMotion(window.matchMedia.bind(window), setReduced);
  }, []);

  return reduced;
}
