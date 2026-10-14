import { describe, expect, test } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }

describe('usage details toggle', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a press runs toggle.js and flips the label (${surface})`, async ($, on) => {
      const runs: string[][] = []
      on('fs.read', () => ({ value: JSON.stringify({ expanded: false }) }))
      on('env.get', () => ({ value: '/home/test' }))
      on('process.run', (_, e) => {
        runs.push([...e.argv])
        return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      })
      on('session.start', (_, e) => ({ cwd: e.cwd }))
      on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
      await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

      const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })
      expect((await ui.find({ key: 'toggle' }))?.text).toContain('usage details')

      await ui.press({ key: 'toggle' })
      expect(runs).toHaveLength(1)
      expect(runs[0]?.[0]).toBe('node')
      expect(runs[0]?.[1]).toMatch(/scripts\/toggle\.js$/)
      expect(runs[0]?.[2]).toBe('on')
      expect((await ui.find({ key: 'toggle' }))?.text).toContain('hide usage details')

      await ui.press({ key: 'toggle' })
      expect(runs[1]?.[2]).toBe('off')
    })
  }

  test('yields the band to a survey', async ($, on) => {
    on('fs.read', () => ({ value: '{}' }))
    on('env.get', () => ({ value: undefined }))
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, hasSurvey: true } })
    expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  })
})
