import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("所有智能输出存笔记都等待真实结果，失败时恢复按钮而非假报成功", () => {
  const studio = read("components/Studio.tsx");
  const home = read("components/HomeClient.tsx");
  const viewerActions = studio.match(/function ViewerActions\([\s\S]*?\n}\n\n\/\/ ---------------------------------------------------------------------------/)?.[0] ?? "";
  const flashcards = studio.match(/export function FlashcardsView\([\s\S]*?\/\/ ---------------------------------------------------------------------------\n\/\/ quiz/)?.[0] ?? "";
  const quiz = studio.match(/export function QuizView\([\s\S]*?\/\/ ---------------------------------------------------------------------------\n\/\/ infographic/)?.[0] ?? "";
  assert.match(viewerActions, /onClick=\{async/);
  assert.match(viewerActions, /await onSaveNote\(\)/);
  assert.match(viewerActions, /saveRef\.current = false/);
  assert.match(flashcards, /await onSaveNote\(output\.title, asNote\(\)\)/);
  assert.match(flashcards, /noteSaveRef\.current = false/);
  assert.match(quiz, /await onSaveNote\(output\.title, asNote\(\)\)/);
  assert.match(quiz, /noteSaveRef\.current = false/);
  assert.match(studio, /正在保存…/);
  assert.doesNotMatch(home, /onSaveNote=\{\(t, c\) => void addNote/);
  assert.match(home, /onSaveNote=\{async \(t, c\) => !!\(await addNote\(t, c, "report"\)\)\}/);
});

test("概览保存仅在接口成功后显示已添加，失败可重试", () => {
  const home = read("components/HomeClient.tsx");
  const overview = home.match(/function OverviewActions\([\s\S]*?\n}\n\nfunction EmptyChat/)?.[0] ?? "";
  assert.match(overview, /onClick=\{async/);
  assert.match(overview, /await onSaveNote\(summary\)/);
  assert.match(overview, /savedRef\.current = false/);
  assert.match(overview, /添加到笔记失败,请重试/);
});

test("赞踩、删除和转入笔记都以服务端结果为准，失败会回滚", () => {
  const home = read("components/HomeClient.tsx");
  const feedback = home.match(/const setFeedback = useCallback\([\s\S]*?\n  \);\n\n  const generateStudio/)?.[0] ?? "";
  const deletion = home.match(/const doDeleteOutput = useCallback[\s\S]*?const deleteOutput/)?.[0] ?? "";
  const move = home.match(/const moveOutputToNote = useCallback[\s\S]*?\n  \);\n\n  const saveAnswerToNote/)?.[0] ?? "";
  assert.match(feedback, /messagesRef\.current\.find/);
  assert.match(feedback, /if \(!response\.ok\) throw/);
  assert.match(feedback, /feedback: previous/);
  assert.doesNotMatch(feedback, /let next[\s\S]*setMessages/,
    "不得依赖延后的 React updater 修改当前请求 body");
  assert.match(deletion, /Promise<boolean>/);
  assert.match(deletion, /if \(!response\.ok\) throw/);
  assert.match(deletion, /restored\.splice/);
  assert.match(move, /const deleted = await doDeleteOutput/);
  assert.match(move, /if \(!deleted\)[\s\S]*method: "DELETE"/);
  assert.match(move, /转入未完成/);
});
