import { BUDGET_MAX_ACTIONS, BUDGET_MAX_NOTES, BUDGET_MAX_PAYEE } from '../utils/budget.ts';

/**
 * Второй инструмент помощника — деньги. Отдельная схема, а не расширение
 * `planner_actions`: у календаря и бюджета разные лимиты и разные правила
 * безопасности, а модели проще выбирать, когда инструмент назван по делу.
 *
 * Аргументы приходят строкой JSON и разбираются `parsePlannerArgs`: форма
 * ответа та же — `reply` плюс массив свободно описанных действий, мусор
 * отбрасывает `normalizeBudgetAction`.
 */
export const BUDGET_ACTIONS_TOOL = {
  type: 'function',
  function: {
    name: 'budget_actions',
    description:
      'Записать расход, доход или перевод по бюджету, оплатить регулярный платёж. Вызывай на каждый ответ помощника; если пользователь не просит ничего записать, оставляй actions пустым.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['reply'],
      properties: {
        reply: {
          type: 'string',
          description: 'Ответ пользователю по-русски: 1–3 коротких предложения.'
        },
        actions: {
          type: 'array',
          description: `Не больше ${BUDGET_MAX_ACTIONS} действий за ответ.`,
          maxItems: BUDGET_MAX_ACTIONS,
          items: {
            type: 'object',
            required: ['type'],
            properties: {
              type: {
                type: 'string',
                enum: [
                  'transaction.expense',
                  'transaction.income',
                  'transaction.transfer',
                  'obligation.pay'
                ],
                description:
                  'Что сделать: расход, доход, перевод между счетами (transaction.*) или оплата регулярного платежа (obligation.pay).'
              },
              amount: {
                type: 'number',
                description:
                  'Сумма в рублях, как назвал пользователь: «потратил 500» — это 500, а не 50000. Для obligation.pay необязательна: по умолчанию берётся сумма платежа.'
              },
              date: {
                type: 'string',
                description:
                  'Дата ГГГГ-ММ-ДД. Если день не назван — оставь пустой: запись пойдёт на сегодня.'
              },
              accountId: {
                type: 'string',
                description:
                  'id счёта из списка в контексте. Для obligation.pay можно не указывать — возьмётся счёт платежа.'
              },
              toAccountId: {
                type: 'string',
                description: 'id счёта-получателя, только для transaction.transfer.'
              },
              categoryId: {
                type: 'string',
                description:
                  'id категории из списка в контексте. Для перевода категория не нужна. Не выдумывай id: с неизвестной категорией операция не запишется.'
              },
              payee: {
                type: 'string',
                description: `Кому или за что заплатили: «Пятёрочка», «Аренда», до ${BUDGET_MAX_PAYEE} символов.`
              },
              notes: {
                type: 'string',
                description: `Короткая заметка к операции, до ${BUDGET_MAX_NOTES} символов.`
              },
              id: {
                type: 'string',
                description: 'id существующего платежа — только для obligation.pay.'
              }
            }
          }
        }
      }
    }
  }
} as const;
