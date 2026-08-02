import React from "react";
import type { IconName } from "../types";

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    code: <><path d="m8 9-3 3 3 3"/><path d="m16 9 3 3-3 3"/><path d="m14 6-4 12"/></>,
    computer: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 8c5 0 5-2 8-2"/></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
    message: <><path d="M5 18 3 21l4-1h11a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v9a3 3 0 0 0 2 3Z"/><path d="M8 9h8M8 13h5"/></>,
    diff: <><path d="M6 4v16M3 7h6M15 6h6M18 3v6M15 18h6"/></>,
    spark: <path d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5L12 2Z"/>,
    shield: <path d="M12 3 5 6v5c0 4.8 3 8 7 10 4-2 7-5.2 7-10V6l-7-3Z"/>,
    route: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h5a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3M9 18H5a2 2 0 0 1-2-2v-2"/></>,
    rocket: <><path d="M14 5c3-3 6-2 6-2s1 3-2 6l-5 5-4-4 5-5Z"/><path d="m9 10-4 1-2 3 6 1M13 14l-1 5-3 2-1-6"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.8-1.9.9-1.9-2.1-2.1-1.9.9-1.9-.8-.7-2h-3l-.7 2-1.9.8-1.9-.9L.9 6 2 7.9l-.8 1.9-2 .7v3l2 .7.8 1.9L.9 18l2.1 2.1 1.9-.9 1.9.8.7 2h3l.7-2 1.9-.8 1.9.9L18.1 18l-.9-1.9.8-1.9 2-.7Z" transform="translate(2) scale(.83)"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

