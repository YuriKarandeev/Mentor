<script lang="ts">
  import type { Citation } from '../db/db';
  import Markdown from './Markdown.svelte';

  let {
    role,
    content,
    reasoning = '',
    citations = [],
    streaming = false,
    error = ''
  }: {
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    citations?: Citation[];
    streaming?: boolean;
    error?: string;
  } = $props();

  let showReasoning = $state(false);
</script>

<div class="msg {role}">
  <div class="avatar">{role === 'user' ? 'Я' : '🎓'}</div>
  <div class="body">
    {#if error}
      <div class="err">{error}</div>
    {/if}

    {#if role === 'assistant' && reasoning}
      <div class="reason">
        <button class="reason-btn" onclick={() => (showReasoning = !showReasoning)}>
          {showReasoning ? '▾' : '▸'} Размышления · {reasoning.length} симв.
        </button>
        {#if showReasoning}
          <pre class="reason-text">{reasoning}</pre>
        {/if}
      </div>
    {/if}

    {#if content}
      <Markdown md={content} />
    {:else if streaming}
      <div class="typing"><span></span><span></span><span></span></div>
    {/if}

    {#if citations.length > 0}
      <div class="cites">
        <div class="cites-title">Источники</div>
        <ul>
          {#each citations as c (c.url)}
            <li>
              <a href={c.url} target="_blank" rel="noreferrer noopener">{c.title || c.url}</a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</div>

<style>
  .msg {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 0;
  }

  .avatar {
    flex: 0 0 32px;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 0.78rem;
    font-weight: 700;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-soft);
  }

  .assistant .avatar {
    background: var(--accent-soft);
    border-color: transparent;
  }

  .body {
    flex: 1;
    min-width: 0;
  }

  .user .body {
    background: var(--bg-elev-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-m);
    padding: 10px 14px;
  }

  .err {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    border-radius: var(--radius-s);
    padding: 8px 12px;
    font-size: 0.88rem;
    margin-bottom: 8px;
    white-space: pre-wrap;
  }

  .reason {
    margin-bottom: 8px;
  }

  .reason-btn {
    background: none;
    border: none;
    color: var(--text-mute);
    font-size: 0.78rem;
    padding: 2px 0;
  }

  .reason-text {
    margin: 6px 0 0;
    padding: 10px 12px;
    background: var(--code-bg);
    border: 1px dashed var(--border);
    border-radius: var(--radius-s);
    font-size: 0.78rem;
    color: var(--text-dim);
    white-space: pre-wrap;
    max-height: 260px;
    overflow: auto;
  }

  .cites {
    margin-top: 10px;
    border-top: 1px dashed var(--border-soft);
    padding-top: 8px;
    font-size: 0.8rem;
  }

  .cites-title {
    color: var(--text-mute);
    margin-bottom: 4px;
  }

  .cites ul {
    margin: 0;
    padding-left: 18px;
  }

  .typing {
    display: inline-flex;
    gap: 4px;
    padding: 6px 0;
  }

  .typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: blink 1.2s infinite ease-in-out;
  }

  .typing span:nth-child(2) {
    animation-delay: 0.18s;
  }

  .typing span:nth-child(3) {
    animation-delay: 0.36s;
  }

  @keyframes blink {
    0%,
    100% {
      opacity: 0.25;
      transform: translateY(0);
    }
    50% {
      opacity: 1;
      transform: translateY(-2px);
    }
  }
</style>
