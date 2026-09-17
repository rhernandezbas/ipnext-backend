/**
 * The IClass close push only exists in production if app.ts hands it to BOTH writers of
 * generalStatus. Every unit test injects its own instance, so none of them can notice
 * that the composition root forgot the argument (memory: "la función que decide no es la
 * que se testea"). This reads the real source, with comments stripped.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripComments, extractCallArgs, splitTopLevelArgs } from '../helpers/staticSourceScan';

const APP = stripComments(readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8'));

describe('app.ts wires PushIClassClosureOnTaskEnd into the generalStatus writers', () => {
  it('sanity: the file was read and builds the push service from the real collaborators', () => {
    expect(APP).toMatch(/const iclassClosurePush = new PushIClassClosureOnTaskEnd\(\s*buildIClassClient\(\)/);
    expect(APP).toMatch(/import\s+\{\s*PushIClassClosureOnTaskEnd\s*\}/);
  });

  // Membership, not position: adding another optional collaborator must not fail this.
  it.each(['new SetTaskGeneralStatus(', 'new UpdateTask('])('%s receives it', call => {
    const invocations = extractCallArgs(APP, call);
    expect(invocations).toHaveLength(1);

    const args = splitTopLevelArgs(invocations[0]!).map(a => a.trim());
    expect(args).toContain('iclassClosurePush');
  });

  it('self-test: a call without the argument is rejected by the matcher', () => {
    const args = splitTopLevelArgs(extractCallArgs('const x = new SetTaskGeneralStatus(repo, recorder);', 'new SetTaskGeneralStatus(')[0]!).map(a => a.trim());
    expect(args).not.toContain('iclassClosurePush');
  });
});
