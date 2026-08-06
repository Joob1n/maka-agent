import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import {
  deriveTitlebarProjectName,
  TitlebarSessionIdentity,
} from '../titlebar-session-identity.js';

/**
 * The titlebar is the only place an open session states what it is. The name
 * lives otherwise only in the sidebar list (gone when that column collapses),
 * and the project only in the composer's WorkspacePicker (gone the moment a
 * session exists). So these assertions are about presence, not decoration.
 */
function render(props: { sessionName: string; projectName?: string }): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <TitlebarSessionIdentity
        sessionName={props.sessionName}
        onRenameSession={() => undefined}
        project={
          props.projectName
            ? { name: props.projectName, onOpenFolder: () => undefined }
            : undefined
        }
      />
    </LocaleProvider>,
  );
}

describe('TitlebarSessionIdentity', () => {
  it('states the project and the session name as one trail', () => {
    const html = render({ sessionName: 'Rerun head-to-head', projectName: 'maka-agent' });
    assert.match(html, /maka-agent/);
    assert.match(html, /Rerun head-to-head/);
    assert.ok(
      html.indexOf('maka-agent') < html.indexOf('Rerun head-to-head'),
      'project must precede the session it contains',
    );
  });

  it('degrades to the session name alone when no directory is known', () => {
    const html = render({ sessionName: 'Scratch session' });
    assert.match(html, /Scratch session/);
    // One crumb, so no separator: an empty leading crumb would read as a
    // project whose name failed to load.
    assert.equal(html.match(/<li/g)?.length, 1);
  });

  it('makes both segments real controls, not decorated text', () => {
    // Regression: BreadcrumbItem renders `isCurrent` items as a plain
    // <span aria-current="page"> and DISCARDS onClick. Rendered that way the
    // rename affordance is dead and unreachable by keyboard.
    const html = render({ sessionName: 'Rerun head-to-head', projectName: 'maka-agent' });
    assert.equal(
      html.match(/<button[^>]*type="button"/g)?.length,
      2,
      'project and session segments must both be buttons',
    );
    assert.doesNotMatch(html, /aria-current/);
  });

  it('truncates each segment on its own rather than wrapping the strip', () => {
    const html = render({ sessionName: 'A'.repeat(200), projectName: 'B'.repeat(200) });
    assert.equal(
      html.match(/maka-titlebar-identity__segment/g)?.length,
      2,
      'both segments carry the ellipsis class',
    );
  });
});

describe('deriveTitlebarProjectName', () => {
  it('prefers the registered project name over the path', () => {
    assert.equal(
      deriveTitlebarProjectName({ projectName: 'Maka', projectPath: '/src/maka-agent' }),
      'Maka',
    );
  });

  it('names the folder for a session started outside the project catalog', () => {
    assert.equal(deriveTitlebarProjectName({ projectPath: '/src/maka-agent' }), 'maka-agent');
  });

  it('ignores a trailing separator instead of naming nothing', () => {
    assert.equal(deriveTitlebarProjectName({ projectPath: '/src/maka-agent/' }), 'maka-agent');
  });

  it('reads a Windows path, which is what a Windows host sends', () => {
    assert.equal(deriveTitlebarProjectName({ projectPath: 'C:\\src\\maka-agent' }), 'maka-agent');
  });

  it('is undefined at a filesystem root, and with no path at all', () => {
    assert.equal(deriveTitlebarProjectName({ projectPath: '/' }), undefined);
    assert.equal(deriveTitlebarProjectName({}), undefined);
  });
});
