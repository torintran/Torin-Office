/**
 * Public entry for the multi-provider LLM layer.
 */

export {
  validateMessages,
  flattenMessagesForCli,
  requireNonEmptyText,
  unknownHealth,
} from './types.js'

export { joinBaseUrl, stripTrailingSlashes, validateBaseUrl, validateApiKeyEnv } from './url.js'
export { resolveApiKey, parseEnvFile, missingKeyHint, envFilePaths } from './envKeys.js'
export { chatCompletions, fetchJsonLimited } from './openaiCompatible.js'
export {
  resolveProvider,
  listProviderIds,
  listProviderMeta,
  getProviderMetadata,
} from './registry.js'
export {
  resolveChatAiConfig,
  normalizeStoredChatAi,
  defaultsForProvider,
  defaultStoredChatAi,
  applyProviderSwitch,
  publicChatAiView,
  DEFAULT_TIMEOUT_SEC,
} from './config.js'
