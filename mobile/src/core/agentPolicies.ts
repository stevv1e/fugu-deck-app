import type { AgentApprovalAction, AgentApprovals } from "./api";

export const APPROVAL_MODES: [AgentApprovals, string][] = [
  ["", "по общему"],
  ["sign", "подпись"],
  ["tap", "кнопка"],
  ["dangerous", "только опасные"],
  ["none", "автоматически"],
];

export const APPROVAL_ACTIONS: { id: AgentApprovalAction; title: string; description: string; access?: "git" | "memory" | "files" | "mcp" | "media" | "drive" }[] = [
  { id: "commit_files", title: "Коммиты", description: "Создание, изменение и удаление файлов в любой ветке, включая основную.", access: "git" },
  { id: "create_pull_request", title: "Pull / Merge Request", description: "Создание PR в GitHub и MR в GitLab.", access: "git" },
  { id: "create_branch", title: "Новые ветки", description: "Создание веток в подключённых репозиториях.", access: "git" },
  { id: "create_repo", title: "Новые репозитории", description: "Создание публичных или приватных репозиториев от вашего имени.", access: "git" },
  { id: "project_repo_set", title: "Репозитории проекта", description: "Добавление и удаление репозиториев в настройках проекта.", access: "git" },
  { id: "memory_save", title: "Новые заметки", description: "Сохранение сведений в базу знаний проекта.", access: "memory" },
  { id: "memory_update", title: "Изменение заметок", description: "Перезапись существующих заметок базы знаний.", access: "memory" },
  { id: "memory_link", title: "Связи заметок", description: "Создание связей между записями базы знаний.", access: "memory" },
  { id: "memory_delete", title: "Удаление заметок", description: "Безвозвратное удаление записей базы знаний.", access: "memory" },
  { id: "create_file", title: "Файлы для пользователя", description: "Создание файлов и архивов, которые агент прикладывает к чату.", access: "files" },
  { id: "transcribe_media", title: "Транскрибация", description: "Отправка аудио или видео выбранному облачному провайдеру и создание транскриптов.", access: "media" },
  { id: "process_pdf", title: "PDF и OCR", description: "Обработка всего PDF или выбранного диапазона страниц на выделенном worker.", access: "files" },
  { id: "media_cancel", title: "Остановка медиа-задач", description: "Отмена текущей обработки аудио, видео или PDF, включая удалённый OCR.", access: "media" },
  { id: "drive_import", title: "Импорт из Google Drive", description: "Скачивание или экспорт выбранного файла из Google Drive во вложения чата.", access: "drive" },
  { id: "delegate", title: "Запуск под-агентов", description: "Создание под-задач и повторный запуск под-агентов для исправлений." },
  { id: "mcp", title: "Изменения через MCP", description: "Все инструменты подключённых MCP-серверов, которые не помечены как чтение.", access: "mcp" },
];

export function approvalActionTitle(id: string): string {
  return APPROVAL_ACTIONS.find((action) => action.id === id)?.title ?? id;
}
