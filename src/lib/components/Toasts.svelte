<script lang="ts">
  import { toasts } from '../stores/toast.svelte';
</script>

<div class="toasts">
  {#each toasts.items as t (t.id)}
    <button class="toast {t.kind}" onclick={() => toasts.dismiss(t.id)}>
      {t.text}
    </button>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(var(--nav-h) + 16px + var(--safe-bottom));
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(520px, calc(100vw - 24px - var(--safe-left) - var(--safe-right)));
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    text-align: left;
    border-radius: var(--radius-s);
    border: 1px solid var(--border);
    background: var(--bg-elev);
    color: var(--text);
    padding: 10px 14px;
    font-size: 0.88rem;
    box-shadow: var(--shadow);
    white-space: pre-wrap;
  }

  .toast.error {
    border-color: color-mix(in srgb, var(--danger) 50%, var(--border));
    color: var(--danger);
  }

  .toast.success {
    border-color: color-mix(in srgb, var(--ok) 50%, var(--border));
    color: var(--ok);
  }

  @media (min-width: 900px) {
    .toasts {
      bottom: 24px;
    }
  }
</style>
