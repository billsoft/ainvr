import { labelDisplay } from '@/features/labelNames';
import type { AiDetection } from '@/types/aiChannel';

export interface PatrolLabel {
  label_id: string;
  name: string;
  class_id: number;
}

const priorityGroups = [
  ['常用目标', ['face', 'person', 'car', 'motorcycle', 'bicycle', 'fire', 'smoke', 'truck', 'bus', 'license_plate']],
  ['动物', ['dog', 'cat', 'bird', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe']],
  ['随身物品', ['backpack', 'handbag', 'suitcase', 'umbrella', 'cell phone', 'tie']],
] as const;

export function patrolLabelGroups(labels: readonly PatrolLabel[]) {
  const unique = [...new Map(labels.map(l => [l.label_id, l])).values()];
  const remaining = new Set(unique);
  const groups = priorityGroups.map(([title, names]) => {
    const items: PatrolLabel[] = [];
    for (const name of names) {
      for (const label of remaining) {
        if (label.name.trim().toLowerCase() === name) {
          items.push(label);
          remaining.delete(label);
        }
      }
    }
    return {title: String(title), items};
  });
  groups.push({title: '其他目标', items: [...remaining].sort((a, b) =>
    labelDisplay(a.name).localeCompare(labelDisplay(b.name), 'zh-CN'))});
  return groups.filter(group => group.items.length);
}

export function largestPatrolTarget(label: PatrolLabel, detections: readonly AiDetection[], eligible?: ReadonlySet<string>) {
  const counts = new Map<string, number>();
  for (const d of detections) if (d.track_id && !d.predicted && !d.lowConfidence)
    counts.set(d.track_id, (counts.get(d.track_id) ?? 0) + 1);
  let best: string | undefined;
  let area = 0;
  for (const d of detections) {
    const id = d.track_id;
    if (!id || d.predicted || d.lowConfidence || counts.get(id) !== 1 || (eligible && !eligible.has(id))) continue;
    // Older SEI frames can omit the stable ID. Require both catalog fields then.
    if (d.label_id ? d.label_id !== label.label_id || d.class_name !== label.name :
        d.class_id !== label.class_id || d.class_name !== label.name) continue;
    const { w, h } = d.bbox;
    if (w > 0 && h > 0 && Number.isFinite(w * h) && w * h > area) {
      best = id;
      area = w * h;
    }
  }
  return best;
}
