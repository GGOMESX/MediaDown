<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { loadSettings, saveSettings, DEFAULT_SETTINGS, type Settings } from '@/core/settings';
import { t } from '@/core/i18n';

const form = ref<Settings>({ ...DEFAULT_SETTINGS });
const saved = ref(false);

onMounted(async () => {
  form.value = await loadSettings();
});

async function save() {
  // Show the normalized value back, so the user sees exactly which folder will be used.
  form.value = await saveSettings(form.value);
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}
</script>

<template>
  <main class="options">
    <h1 class="options__title">{{ t('optionsTitle') }}</h1>
    <form class="options__form" @submit.prevent="save">
      <label class="field">
        <span class="field__label">{{ t('optionsFolderLabel') }}</span>
        <input v-model="form.folder" class="field__input" type="text" name="folder" autocomplete="off" />
        <span class="field__hint">{{ t('optionsFolderHint') }}</span>
      </label>

      <label class="checkbox">
        <input v-model="form.askWhereToSave" type="checkbox" name="askWhereToSave" />
        <span>{{ t('optionsAskLabel') }}</span>
      </label>

      <div class="options__actions">
        <button class="button" type="submit">{{ t('optionsSave') }}</button>
        <span v-if="saved" class="options__saved" role="status">{{ t('optionsSaved') }}</span>
      </div>
    </form>
  </main>
</template>
