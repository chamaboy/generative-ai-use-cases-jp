import { useMemo } from 'react';
import useChat from './useChat';
import useChatApi from './useChatApi';
import useRagApi from './useRagApi';
import { ShownMessage } from 'generative-ai-use-cases-jp';
import { findModelByModelId } from './useModel';
import { getPrompter } from '../prompts';
import {
  QueryResultItem,
  RetrieveResultItem,
  DocumentAttribute,
} from '@aws-sdk/client-kendra';

// 同一のドキュメントとみなす Key 値
const uniqueKeyOfItem = (item: RetrieveResultItem): string => {
  const pageNumber =
    item.DocumentAttributes?.find(
      (a: DocumentAttribute) => a.Key === '_excerpt_page_number'
    )?.Value?.LongValue ?? '';
  const uri = item.DocumentURI;
  return `${uri}_${pageNumber}`;
};

const arrangeItems = (items: RetrieveResultItem[]): RetrieveResultItem[] => {
  const res: Record<string, RetrieveResultItem> = {};

  for (const item of items) {
    const key = uniqueKeyOfItem(item);

    if (res[key]) {
      // 同じソースの Content は ... で接続する
      res[key].Content += ' ... ' + item.Content;
    } else {
      res[key] = item;
    }
  }

  return Object.values(res);
};

const useRag = (id: string) => {
  const {
    getModelId,
    messages,
    postChat,
    clear,
    loading,
    setLoading,
    updateSystemContext,
    popMessage,
    pushMessage,
    isEmpty,
  } = useChat(id);

  const modelId = getModelId();
  const { retrieve, query } = useRagApi();
  const { predict } = useChatApi();
  const prompter = useMemo(() => {
    return getPrompter(modelId);
  }, [modelId]);

  return {
    isEmpty,
    clear,
    loading,
    messages,
    postMessage: async (content: string) => {
      const model = findModelByModelId(modelId);

      if (!model) {
        console.error(`model not found for ${modelId}`);
        return;
      }

      // Kendra から Retrieve する際に、ローディング表示する
      setLoading(true);
      pushMessage('user', content);
      pushMessage('assistant', 'Kendra から参照ドキュメントを取得中...');

      const searchQuery = await predict({
        model: model,
        messages: [
          {
            role: 'user',
            content: prompter.ragPrompt({
              promptType: 'RETRIEVE',
              retrieveQueries: [content],
            }),
          },
        ],
      });

      // Kendra から 参考ドキュメントを Retrieve してシステムコンテキストとして設定する
      const items = await retrieve(searchQuery);
      const faqs = await (
        await query(searchQuery)
      ).data.ResultItems?.filter((item) => item.Type === 'QUESTION_ANSWER');
      console.log(faqs); //適宜消してください
      const docItems = [...(items.data.ResultItems ?? [])].slice(0, 3);
      const faqItems = [...(faqs ?? [])].slice(0, 3);
      if ((items.data.ResultItems ?? []).length === 0) {
        popMessage();
        pushMessage(
          'assistant',
          `参考ドキュメントが見つかりませんでした。次の対応を検討してください。
- Amazon Kendra の data source に対象のドキュメントが追加されているか確認する
- Amazon Kendra の data source が sync されているか確認する
- 入力の表現を変更する`
        );
        setLoading(false);
        return;
      }

      const combinedContextItems = [...docItems, ...faqItems] as (
        | RetrieveResultItem
        | QueryResultItem
      )[];

      console.log(combinedContextItems);

      updateSystemContext(
        prompter.ragPrompt({
          promptType: 'SYSTEM_CONTEXT',
          referenceItems: combinedContextItems,
        })
      );

      // ローディング表示を消してから通常のチャットの POST 処理を実行する
      popMessage();
      popMessage();
      postChat(
        content,
        false,
        (messages: ShownMessage[]) => {
          // 前処理：Few-shot で参考にされてしまうため、過去ログから footnote を削除
          return messages.map((message) => ({
            ...message,
            content: message.content.replace(/\[\^(\d+)\]:.*/g, ''),
          }));
        },
        (message: string) => {
          // 後処理：Footnote の付与
          const footnote = items
            .map((item, idx) => {
              // 参考にしたページ番号がある場合は、アンカーリンクとして設定する
              const _excerpt_page_number = item.DocumentAttributes?.find(
                (attr) => attr.Key === '_excerpt_page_number'
              )?.Value?.LongValue;
              return message.includes(`[^${idx}]`)
                ? `[^${idx}]: [${item.DocumentTitle}${
                    _excerpt_page_number
                      ? `(${_excerpt_page_number} ページ)`
                      : ''
                  }](${item.DocumentURI}${
                    _excerpt_page_number ? `#page=${_excerpt_page_number}` : ''
                  })`
                : '';
            })
            .filter((x) => x)
            .join('\n');
          return message + '\n' + footnote;
        }
      );
    },
  };
};

export default useRag;
