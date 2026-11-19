import { ref, onMounted } from 'vue';
import { browser } from 'wxt/browser';
import type { CompanionStatus } from '@/core/messages';

/** Asking also wakes the host once, so the popup can tell whether HLS/DASH is possible. */
export function useCompanionStatus() {
  const status = ref<CompanionStatus | null>(null);
  onMounted(async () => {
    try {
      status.value = (await browser.runtime.sendMessage({ type: 'companionStatus' })) as CompanionStatus;
    } catch {
      status.value = { state: 'incompatible' };
    }
  });
  return { status };
}
