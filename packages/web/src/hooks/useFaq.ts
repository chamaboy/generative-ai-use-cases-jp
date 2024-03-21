import { useMemo } from 'react';
import useChat from './useChat';
import useChatApi from './useChatApi';
import useRagApi from './useRagApi';
import { ShownMessage } from 'generative-ai-use-cases-jp';
import { findModelByModelId } from './useModel';
import { getPrompter } from '../prompts';

const useFaq = (id: string) => {
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
      const faqs =
        (await (
          await query(searchQuery)
        ).data.ResultItems?.filter(
          (item) => item.Type === 'QUESTION_ANSWER'
        ).map((item) => {
          const res = {
            Content: item.DocumentExcerpt?.Text || '',
            Id: item.Id,
            DocumentId: item.DocumentId,
            DocumentTitle: item.DocumentTitle?.Text || '',
            DocumentURI: item.DocumentURI,
            DocumentAttributes: item.DocumentAttributes,
            ScoreAttributes: item.ScoreAttributes,
          };
          console.log({
            faq: res,
          });
          return res;
        })) || [];
      console.log(faqs); //適宜消してください
      console.log(items.data.ResultItems);
      console.log(searchQuery);
      console.log(items.data);

      if ((faqs ?? []).length === 0) {
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

      updateSystemContext(
        prompter.ragPrompt({
          promptType: 'SYSTEM_CONTEXT',
          referenceItems: [...faqs!] ?? [],
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
          const footnote = items.data.ResultItems?.map((item, idx) => {
            // 参考にしたページ番号がある場合は、アンカーリンクとして設定する
            const _excerpt_page_number = item.DocumentAttributes?.find(
              (attr) => attr.Key === '_excerpt_page_number'
            )?.Value?.LongValue;
            return message.includes(`[^${idx}]`)
              ? `[^${idx}]: [${item.DocumentTitle}${
                  _excerpt_page_number ? `(${_excerpt_page_number} ページ)` : ''
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

export default useFaq;
