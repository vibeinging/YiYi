import { makeFunctionalTask } from '../lib/functional-task.mjs';

export default makeFunctionalTask('task_zszq_tiny_no_knowledge', {
  id: 'func-task_zszq_tiny_auto_opt',
  projectName: 'func-task_zszq_tiny_auto_opt',
  auto_optimize: {
    rules_from_gold_reference: true,
    gold_reference_file: 'gold_reference.md',
  },
});
