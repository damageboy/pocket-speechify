function svg(viewBox, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('fill', 'none');
  el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  children.forEach(c => el.appendChild(c));
  return el;
}

function path(d, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', d);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function circle(cx, cy, r, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  el.setAttribute('cx', cx);
  el.setAttribute('cy', cy);
  el.setAttribute('r', r);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export function playIcon() {
  return svg('0 0 24 24',
    path('M7.164 19.84c.474 0 .835-.088 1.283-.36l9.826-5.705c.844-.483 1.336-.958 1.336-1.775 0-.809-.492-1.292-1.336-1.775L8.447 4.52c-.448-.263-.809-.36-1.283-.36-.95 0-1.714.677-1.714 1.907v11.866c0 1.23.765 1.907 1.714 1.907z', { fill: 'currentColor' })
  );
}

export function pauseIcon() {
  return svg('0 0 10 12',
    path('M0 1C0 0.447715 0.447715 0 1 0H3C3.55228 0 4 0.447715 4 1V11C4 11.5523 3.55228 12 3 12H1C0.447715 12 0 11.5523 0 11V1Z', { fill: 'white' }),
    path('M6 1C6 0.447715 6.44772 0 7 0H9C9.55228 0 10 0.447715 10 1V11C10 11.5523 9.55228 12 9 12H7C6.44772 12 6 11.5523 6 11V1Z', { fill: 'white' })
  );
}

export function waveformIcon() {
  const s = svg('0 0 20 20');
  const lines = [
    ['M10 6.66663L10 15'],
    ['M3.33301 8.33337L3.33301 10.8334'],
    ['M16.667 8.33337L16.667 10.8334'],
    ['M6.66699 4.16663L6.66699 12.5'],
    ['M13.333 5L13.333 12.5'],
  ];
  for (const [d] of lines) {
    s.appendChild(path(d, { stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }));
  }
  return s;
}

export function closeIcon() {
  return svg('0 0 20 20',
    path('M4.87361 3.45952C4.48309 3.06899 3.84992 3.06899 3.4594 3.45952C3.06887 3.85004 3.06887 4.48321 3.4594 4.87373L8.58562 9.99996L3.4594 15.1262C3.06887 15.5167 3.06887 16.1499 3.4594 16.5404C3.84992 16.9309 4.48309 16.9309 4.87361 16.5404L9.99984 11.4142L15.1261 16.5404C15.5166 16.9309 16.1498 16.9309 16.5403 16.5404C16.9308 16.1499 16.9308 15.5167 16.5403 15.1262L11.4141 9.99996L16.5403 4.87373C16.9308 4.48321 16.9308 3.85004 16.5403 3.45952C16.1498 3.06899 15.5166 3.06899 15.1261 3.45952L9.99984 8.58575L4.87361 3.45952Z', { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function searchIcon() {
  return svg('0 0 20 20',
    path('M14 9C14 11.7614 11.7614 14 9 14C6.23858 14 4 11.7614 4 9C4 6.23858 6.23858 4 9 4C11.7614 4 14 6.23858 14 9ZM13.1927 14.606C12.0241 15.4814 10.5726 16 9 16C5.13401 16 2 12.866 2 9C2 5.13401 5.13401 2 9 2C12.866 2 16 5.13401 16 9C16 10.5721 15.4818 12.0231 14.6068 13.1916L17.7914 16.3762C18.1819 16.7668 18.1819 17.3999 17.7914 17.7904C17.4009 18.181 16.7677 18.181 16.3772 17.7904L13.1927 14.606Z', { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function skipBackIcon() {
  return svg('0 0 16 16',
    path('M7.48552 5.81939C7.77841 5.5265 7.77841 5.05163 7.48552 4.75873C7.19263 4.46584 6.71776 4.46584 6.42486 4.75873L3.64545 7.53812C3.5048 7.67877 3.42578 7.86953 3.42578 8.06845C3.42578 8.26736 3.5048 8.45813 3.64545 8.59878L6.42486 11.3782C6.71775 11.6711 7.19263 11.6711 7.48552 11.3782C7.77841 11.0853 7.77841 10.6104 7.48552 10.3175L5.23644 8.06845L7.48552 5.81939ZM12.0343 5.81939C12.3272 5.5265 12.3272 5.05163 12.0343 4.75873C11.7415 4.46584 11.2666 4.46584 10.9737 4.75873L8.19428 7.53812C8.05363 7.67877 7.97461 7.86953 7.97461 8.06845C7.97461 8.26736 8.05363 8.45813 8.19428 8.59878L10.9737 11.3782C11.2666 11.6711 11.7415 11.6711 12.0343 11.3782C12.3272 11.0853 12.3272 10.6104 12.0343 10.3175L9.78527 8.06845L12.0343 5.81939Z', { fill: '#ffffff', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function skipForwardIcon() {
  return svg('0 0 16 16',
    path('M3.96576 4.75873C4.25866 4.46584 4.73353 4.46584 5.02642 4.75873L7.80583 7.53814C7.94648 7.67879 8.0255 7.86956 8.0255 8.06847C8.0255 8.26739 7.94648 8.45815 7.80583 8.5988L5.02642 11.3782C4.73353 11.6711 4.25865 11.6711 3.96576 11.3782C3.67287 11.0853 3.67287 10.6104 3.96577 10.3175L6.21484 8.06847L3.96576 5.81939C3.67287 5.5265 3.67287 5.05163 3.96576 4.75873ZM8.5145 4.75873C8.80739 4.46584 9.28227 4.46584 9.57516 4.75873L12.3546 7.53814C12.4952 7.67879 12.5742 7.86956 12.5742 8.06847C12.5742 8.26739 12.4952 8.45815 12.3546 8.5988L9.57516 11.3782C9.28226 11.6711 8.80739 11.6711 8.5145 11.3782C8.22161 11.0853 8.22161 10.6104 8.5145 10.3175L10.7636 8.06847L8.5145 5.81939C8.22161 5.5265 8.22161 5.05163 8.5145 4.75873Z', { fill: '#ffffff', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function chevronIcon() {
  return svg('0 0 17 17',
    path('M12.7803 6.96967C13.0732 7.26256 13.0732 7.73744 12.7803 8.03033L8.78033 12.0303C8.63968 12.171 8.44891 12.25 8.25 12.25C8.05109 12.25 7.86032 12.171 7.71967 12.0303L3.71967 8.03033C3.42678 7.73744 3.42678 7.26256 3.71967 6.96967C4.01256 6.67678 4.48744 6.67678 4.78033 6.96967L8.25 10.4393L11.7197 6.96967C12.0126 6.67678 12.4874 6.67678 12.7803 6.96967Z', { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function hoverPlayIcon() {
  const s = svg('0 0 24 24');
  s.appendChild(circle('12', '12', '12', { fill: '#4759F7' }));
  s.appendChild(path('M16.5 11.134C17.1667 11.5189 17.1667 12.4811 16.5 12.866L10.5 16.3301C9.83333 16.715 9 16.2339 9 15.4641L9 8.53592C9 7.76611 9.83333 7.28499 10.5 7.66989L16.5 11.134Z', { fill: 'white' }));
  return s;
}

let _progressId = 0;
export function circularProgress(percent) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;
  const gradId = `ps-progress-${_progressId++}`;

  const s = svg('0 0 100 100');

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
  grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '0%');
  const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', '#EA6AFF');
  const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop2.setAttribute('offset', '100%'); stop2.setAttribute('stop-color', '#6B78FC');
  grad.append(stop1, stop2);
  defs.appendChild(grad);
  s.appendChild(defs);

  const arcPath = 'M 50,50 m 0,-46 a 46,46 0 1 1 0,92 a 46,46 0 1 1 0,-92';

  const trail = path(arcPath, {
    stroke: '#2e2e2e', 'stroke-width': '8', fill: 'none', 'fill-opacity': '0',
    'stroke-dasharray': `${circumference} ${circumference}`,
    'stroke-dashoffset': '0',
  });
  s.appendChild(trail);

  const arc = path(arcPath, {
    stroke: `url(#${gradId})`, 'stroke-width': '8', fill: 'none', 'fill-opacity': '0',
    'stroke-linecap': 'round',
    'stroke-dasharray': `${circumference} ${circumference}`,
    'stroke-dashoffset': `${offset}`,
  });
  s.appendChild(arc);

  return s;
}

export function bookmarkIcon() {
  return svg('0 0 21 20',
    path('M16.5 1C17.0523 1 17.5 1.44772 17.5 2V4H19.5C20.0523 4 20.5 4.44772 20.5 5C20.5 5.55228 20.0523 6 19.5 6H17.5V8C17.5 8.55228 17.0523 9 16.5 9C15.9477 9 15.5 8.55228 15.5 8V6H13.5C12.9477 6 12.5 5.55228 12.5 5C12.5 4.44771 12.9477 4 13.5 4H15.5V2C15.5 1.44772 15.9477 1 16.5 1ZM6.16667 4C5.79848 4 5.5 4.29848 5.5 4.66667L5.50003 15.7589L9.99613 13.1362C10.3075 12.9546 10.6925 12.9546 11.0039 13.1362L15.5 15.7589V12C15.5 11.4477 15.9477 11 16.5 11C17.0523 11 17.5 11.4477 17.5 12V17.5C17.5 17.858 17.3086 18.1888 16.9981 18.3671C16.6876 18.5454 16.3054 18.5442 15.9961 18.3637L10.5 15.1577L5.00391 18.3637C4.69458 18.5442 4.31238 18.5454 4.0019 18.3671C3.69142 18.1888 3.5 17.858 3.5 17.5V4.66667C3.5 3.19391 4.69391 2 6.16667 2H11.5C12.0523 2 12.5 2.44772 12.5 3C12.5 3.55228 12.0523 4 11.5 4H6.16667Z', { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function aboutIcon() {
  return svg('0 0 20 20',
    path('M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM6.5 10a3.5 3.5 0 1 1 4 3.465v.035a.5.5 0 0 1-1 0v-.5a.5.5 0 0 1 .5-.5 2.5 2.5 0 1 0-2.5-2.5.5.5 0 0 1-1 0ZM10 15.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z', { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function trashIcon() {
  return svg('0 0 20 20',
    path('M8.5 4h3a1.5 1.5 0 0 0-3 0Zm-1 0a2.5 2.5 0 0 1 5 0h4a.5.5 0 0 1 0 1h-.64l-.88 10.12A2.5 2.5 0 0 1 12.49 17H7.51a2.5 2.5 0 0 1-2.49-2.38L4.14 5H3.5a.5.5 0 0 1 0-1h4Zm-1.9 1-.86 10.07A1.5 1.5 0 0 0 7.24 16h5.52a1.5 1.5 0 0 0 1.5-1.43L15.1 5H5.6ZM8.5 7.5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0V8a.5.5 0 0 1 .5-.5Zm3.5.5a.5.5 0 0 0-1 0v5a.5.5 0 0 0 1 0V8Z', { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function reportIcon() {
  return svg('0 0 20 20',
    path('M7.22475 14.299C7.61471 14.329 7.98428 14.4852 8.27756 14.744L10.0034 16.2666L11.7292 14.744C12.0224 14.4852 12.392 14.329 12.782 14.299L15.8904 14.0599C16.2551 14.0319 16.5367 13.7278 16.5367 13.362L16.5368 4.63338C16.5368 4.48678 16.4908 4.38598 16.4501 4.33262C16.4157 4.28758 16.3802 4.26554 16.3259 4.25535C15.1039 4.0262 13.0406 3.76338 10.0034 3.76338C6.96624 3.76338 4.90295 4.02621 3.68099 4.25535C3.62663 4.26554 3.59114 4.28759 3.55679 4.33262C3.51609 4.38598 3.47009 4.48678 3.47009 4.63338L3.47004 13.362C3.47004 13.7278 3.75166 14.0319 4.11636 14.0599L7.22475 14.299Z', { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function settingsIcon() {
  return svg('0 0 24 24',
    path('M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z', { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

export function libraryIcon() {
  const s = svg('0 0 20 20',
    path('M10 2C5.58172 2 2 5.58172 2 10C2 14.4183 5.58172 18 10 18C14.4183 18 18 14.4183 18 10C18 5.58172 14.4183 2 10 2Z', { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
  return s;
}

export function upgradeIcon() {
  return svg('0 0 20 20',
    path('M6.50001 7C5.94772 7 5.50001 7.44772 5.50001 8C5.50001 8.55228 5.94772 9 6.50001 9H13.5C14.0523 9 14.5 8.55228 14.5 8C14.5 7.44772 14.0523 7 13.5 7H6.50001Z', { fill: 'currentColor' }),
    path('M5.50001 12C5.50001 11.4477 5.94772 11 6.50001 11H13.5C14.0523 11 14.5 11.4477 14.5 12C14.5 12.5523 14.0523 13 13.5 13H6.50001C5.94772 13 5.50001 12.5523 5.50001 12Z', { fill: 'currentColor' })
  );
}

export function turnOffIcon() {
  return svg('0 0 20 20',
    path('M12.3884 6.38837C12.6813 6.09548 13.1562 6.09548 13.4491 6.38837C13.742 6.68127 13.742 7.15614 13.4491 7.44903L10.9794 9.91867L13.4491 12.3884C13.742 12.6813 13.742 13.1561 13.4491 13.449C13.1563 13.7419 12.6814 13.7419 12.3885 13.449L9.91876 10.9793L7.44903 13.449C7.15613 13.7419 6.68126 13.7419 6.38837 13.449C6.09548 13.1561 6.09548 12.6813 6.38837 12.3884L8.85809 9.91867L6.38843 7.44903C6.09553 7.15614 6.09553 6.68127 6.38842 6.38837C6.68132 6.09548 7.15619 6.09548 7.44908 6.38837L9.91876 8.85802L12.3884 6.38837Z', { fill: '#9f9f9f', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' })
  );
}

/* ---- Settings nav icons ---- */

export function navGeneralIcon() {
  return svg('0 0 20 20',
    path('M3 6.5h14', { stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }),
    circle(13.5, 6.5, 2, { fill: 'currentColor' }),
    path('M3 13.5h14', { stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }),
    circle(6.5, 13.5, 2, { fill: 'currentColor' })
  );
}

export function navPlayButtonsIcon() {
  return svg('0 0 20 20',
    circle(10, 10, 7.5, { stroke: 'currentColor', 'stroke-width': '1.5', fill: 'none' }),
    path('M8.5 7.5L13.5 10L8.5 12.5Z', { fill: 'currentColor' })
  );
}

export function navKeyboardIcon() {
  return svg('0 0 20 20',
    path('M3 7a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z', { stroke: 'currentColor', 'stroke-width': '1.5', fill: 'none' }),
    path('M6 10.5h1M9.5 10.5h1M13 10.5h1M6.5 13h7', { stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' })
  );
}

export function navAccessibilityIcon() {
  return svg('0 0 20 20',
    circle(10, 4.5, 1.75, { fill: 'currentColor' }),
    path('M10 7.5v4.5M7 9.5l3 1 3-1M7.5 17l2.5-4.5 2.5 4.5', { stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' })
  );
}

export function navDebugIcon() {
  return svg('0 0 20 20',
    path('M4.5 7L9 10 4.5 13', { stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }),
    path('M11 13h4.5', { stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' })
  );
}

export function navHistoryIcon() {
  return svg('0 0 20 20',
    path('M10 3a7 7 0 1 0 0 14A7 7 0 0 0 10 3Z', { stroke: 'currentColor', 'stroke-width': '1.5', fill: 'none' }),
    path('M10 6.5v4l2.5 1.5', { stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' })
  );
}
