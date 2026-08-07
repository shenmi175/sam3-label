import { post, del } from './client';

/** POST /api/projects/{pid}/classes/add — classes_text supports newline/comma/semicolon separators. */
export function addClass(projectId: string, classesText: string) {
  return post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/classes/add`, {
    classes_text: classesText,
  });
}

/** DELETE /api/projects/{pid}/classes/{className} */
export function deleteClass(projectId: string, className: string) {
  return del<Record<string, unknown>>(
    `/projects/${encodeURIComponent(projectId)}/classes/${encodeURIComponent(className)}`,
  );
}
