// A clickable toggle above the prompt for the status line details: a click, or
// ctrl+x tab then `e`, runs scripts/toggle.js without a model turn.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const expanded = atom({ plugin: 'usage-bar', key: 'expanded' } as const, false)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
    const config = await $.fs.read(`${dir}/usage-plugin/config.json`).catch(() => '{}')
    let isExpanded = false
    try { isExpanded = JSON.parse(config).expanded === true } catch {}
    await update($, expanded, () => isExpanded)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button } = $.ui.resolve(e)
    const isExpanded = await read($, expanded)

    const toggle = async () => {
      const want = !isExpanded
      const ran = await $.process.run(['node', `${$.plugin.root}/scripts/toggle.js`, want ? 'on' : 'off'])
      if (ran.exitCode !== 0) {
        $.ui.toast(`usage-bar: toggle failed: ${ran.stderr.trim().slice(0, 200)}`)
        return
      }
      await update($, expanded, () => want)
    }

    return (
      <Box justifyContent="flex-end">
        <Button key="toggle" hotkey="e" plain dimColor onPress={toggle}>
          {isExpanded ? '▾ hide usage details' : '▸ usage details'}
        </Button>
      </Box>
    )
  })
}
