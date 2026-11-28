<script lang="ts">
  let {
    points,
    labels = [],
    height = 64,
    tone = 'accent',
    format
  }: {
    /** Значения в копейках; подписи и масштаб считаются внутри. */
    points: number[];
    labels?: string[];
    height?: number;
    tone?: 'accent' | 'good' | 'bad';
    format?: (value: number) => string;
  } = $props();

  const W = 100;
  const H = 40;

  const shape = $derived.by(() => {
    const values = points.length > 0 ? points : [0];
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 0);
    const span = max - min || 1;
    const step = values.length > 1 ? W / (values.length - 1) : 0;
    const coords = values.map((value, index) => {
      const x = values.length > 1 ? index * step : W / 2;
      const y = H - ((value - min) / span) * H;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const line = coords.join(' ');
    const area = `0,${H} ${line} ${W},${H}`;
    return { line, area, min, max };
  });

  const caption = $derived.by(() => {
    if (!format || points.length === 0) return '';
    const first = labels[0] ?? '';
    const last = labels[labels.length - 1] ?? '';
    return `${first ? `${first}: ` : ''}${format(points[0])}${last && labels.length > 1 ? ` → ${last}: ${format(points[points.length - 1])}` : ''}`;
  });
</script>

<div class="spark" class:good={tone === 'good'} class:bad={tone === 'bad'}>
  <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={`height:${height}px`} role="img" aria-label={caption || 'график'}>
    <polygon points={shape.area} class="area"></polygon>
    <polyline points={shape.line} class="line"></polyline>
  </svg>
  {#if caption}<span class="caption tiny mute">{caption}</span>{/if}
</div>

<style>
  .spark {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--accent);
  }

  .spark.good {
    color: var(--ok);
  }

  .spark.bad {
    color: var(--danger);
  }

  svg {
    width: 100%;
    display: block;
    overflow: visible;
  }

  .area {
    fill: color-mix(in srgb, currentColor 16%, transparent);
    stroke: none;
  }

  .line {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
    vector-effect: non-scaling-stroke;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .caption {
    font-variant-numeric: tabular-nums;
  }
</style>
