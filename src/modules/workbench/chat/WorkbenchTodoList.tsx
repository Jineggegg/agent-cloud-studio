import { m } from 'motion/react';
import { Check } from 'lucide-react';

import type { WorkbenchTodoItem } from '@/shared/types';

/**
 * Used by the workbench chat's run status row and checklist tool cards: the agent's checklist as iOS-style rows. The
 * tick draws itself with a spring when a step completes; the step in flight carries a soft pulse.
 */
export function WorkbenchTodoList({ todos }: { todos: WorkbenchTodoItem[] }) {
  return (
    <ol className="wbc-todos" aria-label="任务清单">
      {todos.map((todo, index) => {
        const label = todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content;
        return (
          <li key={`${index}-${todo.content}`} className={`wbc-todo is-${todo.status}`}>
            <span className="wbc-todo-mark" aria-hidden="true">
              {todo.status === 'completed' && (
                <m.span
                  className="wbc-todo-tick"
                  initial={{ scale: 0.2, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 520, damping: 22 }}
                >
                  <Check size={11} strokeWidth={3.2} />
                </m.span>
              )}
            </span>
            <span className="wbc-todo-text">{label}</span>
            <span className="wbc-visually-hidden">
              {todo.status === 'completed' ? '（已完成）' : todo.status === 'in_progress' ? '（进行中）' : '（待办）'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
