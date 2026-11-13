export function serviceIntent(context: string): 'start' | 'status' | 'stop' | undefined {
  const compact = context.toLocaleLowerCase().replace(/[\s“”"'`，。,.!！?？]/g, '');
  if (/^(?:请|请帮我|帮我)?(?:启动|开启|运行)(?:一下)?ask(?:后台)?(?:服务|daemon)?(?:吧)?$/.test(compact)
    || /^(?:please)?(?:start|launch|run)ask(?:service|daemon)?$/.test(compact)) return 'start';
  if (/^(?:请|请帮我|帮我)?(?:查看|检查|显示)?ask(?:后台)?(?:服务|daemon)(?:状态|情况)?$/.test(compact)
    || /^(?:check|show)ask(?:service|daemon)(?:status)?$/.test(compact)) return 'status';
  if (/^(?:请|请帮我|帮我)?(?:停止|关闭)(?:一下)?ask(?:后台)?(?:服务|daemon)?(?:吧)?$/.test(compact)
    || /^(?:stop|shutdown)ask(?:service|daemon)?$/.test(compact)) return 'stop';
  return undefined;
}

export function invokesAsk(shell: string): boolean {
  return /(?:^|[;|&()]\s*)(?:(?:command|sudo|nohup)\s+)*(?:[^\s;|&()]*\/)?ask(?=\s|$|[;|&()])/.test(shell.trim());
}
