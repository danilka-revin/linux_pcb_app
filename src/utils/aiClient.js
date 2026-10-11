/**
 * 🚀 ГОТОВЫЙ AI КЛИЕНТ ДЛЯ БЕСПЛАТНОГО TEAMOROUTER + NARA FALLBACK
 * 
 * КАК ИСПОЛЬЗОВАТЬ:
 * 1. Скопируй .env.teamo.example в .env и вставь свой API ключ в TEAMO_API_KEY
 * 2. Установи openai SDK: npm install openai dotenv
 * 3. Импортируй client из этого файла в любой части кода и используй как обычный OpenAI клиент!
 * 
 * Все настройки уже готовы: автоматический фоллбэк на резервный провайдер если закончится лимит,
 * поддержка tool calling из коробки, режим размышлений включен для умных ответов,
 * температура выставлена для точных ответов.
 */

import 'dotenv/config';
import OpenAI from 'openai';

// Инициализируем основного клиента TeamoRouter
const teamoClient = new OpenAI({
  apiKey: process.env.TEAMO_API_KEY,
  baseURL: process.env.TEAMO_BASE_URL,
  timeout: 60000,
});

// Инициализируем резервного клиента NaraRouter (если указан ключ)
const naraClient = process.env.NARA_API_KEY
  ? new OpenAI({
      apiKey: process.env.NARA_API_KEY,
      baseURL: process.env.NARA_BASE_URL,
      timeout: 60000,
    })
  : null;

/**
 * Отправить запрос к AI с автоматическим фоллбэком если основной провайдер упал/закончился лимит
 * @param {Object} options - Параметры запроса в формате OpenAI chat.completions.create
 * @param {boolean} options.useSmartModel - Использовать умную Pro модель вместо быстрой Flash
 * @returns {Promise<OpenAI.ChatCompletion>} Ответ от модели
 */
export async function chatCompletion(options = {}) {
  const useSmartModel = options.useSmartModel ?? false;
  const defaultParams = {
    temperature: Number(process.env.AI_DEFAULT_TEMPERATURE ?? 0.2),
    max_tokens: Number(process.env.AI_MAX_TOKENS ?? 4096),
    extra_body: process.env.AI_THINKING_MODE_ENABLED === 'true' 
      ? { thinking: { type: 'enabled' } } 
      : undefined,
  };

  const requestParams = { ...defaultParams, ...options };
  delete requestParams.useSmartModel; // удаляем наш служебный параметр

  // Сначала пробуем отправить запрос на основной провайдер
  try {
    requestParams.model = useSmartModel 
      ? process.env.TEAMO_SMART_MODEL 
      : process.env.TEAMO_FAST_MODEL;
    
    const response = await teamoClient.chat.completions.create(requestParams);
    console.log(`✅ Запрос выполнен через TeamoRouter (${requestParams.model})`);
    return response;
  } catch (teamoError) {
    console.warn(`⚠️ TeamoRouter не доступен (${teamoError.message}), пробую резервный NaraRouter...`);
    
    // Если нет резервного клиента — пробрасываем ошибку
    if (!naraClient) {
      throw new Error(`TeamoRouter закончил лимит/не работает, а резервный NaraRouter не настроен: ${teamoError.message}`);
    }

    // Пробуем отправить запрос на резервный провайдер
    try {
      requestParams.model = process.env.NARA_MODEL;
      const response = await naraClient.chat.completions.create(requestParams);
      console.log(`✅ Запрос выполнен через резервный NaraRouter (${requestParams.model})`);
      return response;
    } catch (naraError) {
      throw new Error(`Оба провайдера не работают. Teamo: ${teamoError.message}. Nara: ${naraError.message}`);
    }
  }
}

// Экспортируем также сырые клиенты если нужно работать с ними напрямую
export { teamoClient, naraClient };

// По умолчанию экспортируем функцию для удобства
export default chatCompletion;

// -----------------------------------------------------------------------------
// ПРИМЕР ИСПОЛЬЗОВАНИЯ:
// -----------------------------------------------------------------------------
/*
import chatCompletion from './src/utils/aiClient.js';

// Простой запрос
async function test() {
  const result = await chatCompletion({
    messages: [
      { role: 'user', content: 'Привет! Как дела?' }
    ]
  });
  console.log(result.choices[0].message.content);
}

// Запрос с вызовом инструментов (для агента)
async function agentRequest() {
  const result = await chatCompletion({
    useSmartModel: true, // использовать умную Pro модель для сложных задач
    messages: [
      { role: 'system', content: 'Ты агент для работы с PCB разводкой.' },
      { role: 'user', content: 'Проверь эту схему на ошибки' }
    ],
    tools: [/* твои инструменты здесь */
//    ],
//    tool_choice: 'auto'
//  });
//}
//
//test();
*/
