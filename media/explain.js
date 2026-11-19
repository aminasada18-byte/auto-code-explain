(function () {
  const vscode = acquireVsCodeApi();
  const view = document.getElementById('view');
  const toggle = document.getElementById('toggle');
  const showVariables = document.getElementById('show-variables');
  const retry = document.getElementById('retry');
  const status = document.getElementById('status');
  const location = document.getElementById('location');
  const explanation = document.getElementById('explanation');
  const statuses = new Set(['idle', 'waiting', 'loading', 'success', 'error']);

  function render(nextState) {
    if (!nextState || typeof nextState !== 'object') {
      return;
    }

    const enabled = nextState.enabled === true;
    const nextStatus = statuses.has(nextState.status) ? nextState.status : 'idle';
    const text = typeof nextState.text === 'string' ? nextState.text : '';
    const nextLocation = typeof nextState.location === 'string' ? nextState.location : '';

    toggle.textContent = enabled ? '暂停自动解释' : '启用自动解释';
    toggle.classList.toggle('active', enabled);
    showVariables.checked = nextState.showVariables !== false;
    status.textContent = nextStatus === 'loading' ? '正在解释…' : '';
    location.textContent = nextLocation;
    location.hidden = nextLocation.length === 0;
    explanation.textContent = text;
    retry.hidden = !(nextStatus === 'error' && nextState.canRetry === true);
    view.dataset.status = nextStatus;
  }

  toggle.addEventListener('click', function () {
    vscode.postMessage({ type: 'toggle' });
  });

  showVariables.addEventListener('change', function () {
    vscode.postMessage({ type: 'toggleVariables' });
  });

  retry.addEventListener('click', function () {
    vscode.postMessage({ type: 'retry' });
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || message.type !== 'state') {
      return;
    }
    render(message.state);
  });

  render({
    enabled: false,
    status: 'idle',
    text: '启用自动解释后，选中一行或一段代码即可查看解释。',
  });
  vscode.postMessage({ type: 'ready' });
}());
