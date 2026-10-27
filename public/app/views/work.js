import { byId, api, html, mount, modal, closeModal, onSubmit, toast, showError, $, $$ } from '../../assets/ui.js';
import { pill, options, ctx, canOperate } from '../common.js';

let status = 'open';

export async function render(target, app) {
  const [tasks, questions, clients] = await Promise.all([canOperate() ? api(`/api/tasks?status=${status}`) : [], api('/api/questions'), api('/api/clients')]);
  mount(target, html`<div class="page-head"><div><h1>${canOperate() ? 'Tasks & questions' : 'Questions'}</h1><p>${canOperate() ? 'Follow-ups are created automatically (for example, confirming a withdrawal) and close when the work is recorded.' : 'Ask the team anything about your capital and results.'}</p></div>
      <div class="btn-row">${canOperate() ? html`<button type="button" id="task">New task</button>` : ''}<button type="button" class="primary" id="ask">New question</button></div></div>
    ${canOperate() ? html`<section class="card"><div class="card-head"><h3>Tasks</h3><div class="tabs">${['open', 'done', 'all'].map(s => html`<button type="button" data-s="${s}" class="${status === s ? 'active' : ''}">${s}</button>`)}</div></div>
      ${tasks.length ? html`<div class="list">${tasks.map(t => html`<div class="list-item"><div><b>${t.title}</b> ${t.priority === 'high' ? pill('problem', 'high') : ''}<br><small>${t.client_name || 'All clients'}${t.due_on ? ` · due ${t.due_on}` : ''}${t.assignee ? ` · ${t.assignee}` : ''}${t.detail ? ` · ${t.detail}` : ''}</small></div>
        <div>${t.status === 'open' ? html`<button type="button" data-done="${t.id}">Done</button><button type="button" data-dismiss="${t.id}">Dismiss</button>` : pill(t.status)}</div></div>`)}</div>` : html`<p class="empty">No tasks.</p>`}</section>` : ''}
    <section class="card"><h3>Questions</h3>${questions.length ? questions.map(q => html`<div class="tree-holder"><div class="card-head"><div><b>${q.subject}</b> ${pill(q.status)}<br><small>${q.client_name} · ${q.author}</small></div>${q.status === 'open' ? html`<button type="button" data-reply="${q.id}">Reply</button>` : ''}</div>
      <div class="thread">${q.messages.map(m => html`<div class="${m.author === ctx.me.user.displayName ? 'mine' : ''}"><small>${m.author} · ${m.created_at.slice(0, 16).replace('T', ' ')}</small><br>${m.body}</div>`)}</div></div>`) : html`<p class="empty">No questions yet.</p>`}</section>`);
  const act = async (url, body) => { try { await api(url, { method: 'PATCH', body }); render(target, app); } catch (error) { showError(error); } };
  $$('[data-s]', target).forEach(b => b.addEventListener('click', () => { status = b.dataset.s; render(target, app); }));
  $$('[data-done]', target).forEach(b => b.addEventListener('click', () => act(`/api/tasks/${b.dataset.done}`, { status: 'done' })));
  $$('[data-dismiss]', target).forEach(b => b.addEventListener('click', () => act(`/api/tasks/${b.dataset.dismiss}`, { status: 'dismissed' })));
  $('#task', target)?.addEventListener('click', () => {
    const d = modal({ title: 'New task', body: html`<form id="f" class="form-grid"><div class="full"><label for="t">Title</label><input id="t" name="title" required></div>
      <div><label for="c">Client</label><select id="c" name="clientId">${options(clients.map(c => ({ value: c.id, label: c.name })), '', { blank: 'All clients' })}</select></div><div><label for="d">Due</label><input id="d" name="dueOn" type="date"></div>
      <div><label for="p">Priority</label><select id="p" name="priority">${options([{ value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }, { value: 'low', label: 'Low' }], 'normal')}</select></div>
      <div class="full"><label for="de">Detail</label><textarea id="de" name="detail"></textarea></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create</button>` });
    onSubmit(byId(d, 'f'), async data => { for (const k of ['clientId', 'dueOn']) if (!data[k]) delete data[k]; await api('/api/tasks', { method: 'POST', body: data }); closeModal(); render(target, app); });
  });
  $('#ask', target).addEventListener('click', () => {
    const d = modal({ title: 'New question', body: html`<form id="f" class="form-grid"><div class="full"><label for="c">Client</label><select id="c" name="clientId">${options(clients.map(c => ({ value: c.id, label: c.name })), clients[0]?.id)}</select></div>
      <div class="full"><label for="s">Subject</label><input id="s" name="subject" required></div><div class="full"><label for="b">Message</label><textarea id="b" name="body" required></textarea></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Send</button>` });
    onSubmit(byId(d, 'f'), async data => { await api('/api/questions', { method: 'POST', body: data }); closeModal(); toast('Question sent.'); render(target, app); });
  });
  $$('[data-reply]', target).forEach(b => b.addEventListener('click', () => {
    const d = modal({ title: 'Reply', body: html`<form id="f"><label for="b">Message</label><textarea id="b" name="body" required></textarea>${canOperate() ? html`<label class="check"><input type="checkbox" name="close"> Close the conversation</label>` : ''}</form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Send</button>` });
    onSubmit(byId(d, 'f'), async data => { await api(`/api/questions/${b.dataset.reply}/messages`, { method: 'POST', body: data }); closeModal(); render(target, app); });
  }));
}
