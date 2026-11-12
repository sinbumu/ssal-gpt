import type { Observation } from './browser.js';
import type { Job } from './store.js';

// Storage and execution retain the complete observation/history. Only the model
// projection removes repeated URLs and non-actionable diagnostic metadata.
export function compactDiscoveryContext<
  T extends {
    observation: Omit<Observation, 'image'>;
    history: Job['history'];
    observedUrls: string[];
  },
>(context: T) {
  const o = context.observation;
  const shown = new Set(o.elements.flatMap((e) => (e.href ? [e.href] : [])));
  return {
    ...context,
    history: context.history.slice(-8),
    observedUrls: context.observedUrls.filter((u) => !shown.has(u)).slice(-16),
    observation: {
      id: o.id,
      url: o.url,
      title: o.title,
      text: o.text,
      width: o.width,
      height: o.height,
      hasResponseFields: o.hasResponseFields,
      elements: o.elements.map((e) => ({
        ref: e.ref,
        tag: e.tag,
        role: e.role || undefined,
        type: e.type || undefined,
        label: e.label,
        context: e.context,
        href: e.href,
        navigationOnly: e.navigationOnly || undefined,
        mediaNavigation: e.mediaNavigation,
        readDisclosure: e.readDisclosure,
        checked: e.checked,
        rect: [e.x, e.y, e.width, e.height].map(Math.round),
      })),
    },
  };
}
