<script lang="ts">
  import { renderMarkdown } from '../utils/markdown';

  let { md }: { md: string } = $props();

  const html = $derived(renderMarkdown(md));
</script>

<div class="md">{@html html}</div>
