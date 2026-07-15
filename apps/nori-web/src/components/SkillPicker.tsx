import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api, type SkillDescriptor } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

export function SkillPicker({ sessionId, disabled }: { sessionId: string | null; disabled?: boolean }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SkillDescriptor | null>(null);
  const [args, setArgs] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(false);
    setSkills([]);
    setSelected(null);
    setArgs('');
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const updatePopoverPosition = useCallback(() => {
    const anchor = rootRef.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const chatRect = anchor.closest('.chat-view')?.getBoundingClientRect();
    const boundaryLeft = Math.max(12, chatRect?.left ?? 12);
    const boundaryRight = Math.min(window.innerWidth - 12, chatRect?.right ?? window.innerWidth - 12);
    const width = Math.max(240, Math.min(340, boundaryRight - boundaryLeft - 16));
    const preferredLeft = anchorRect.right - width;
    const left = Math.min(
      Math.max(preferredLeft, boundaryLeft + 8),
      Math.max(boundaryLeft + 8, boundaryRight - width - 8),
    );
    const availableHeight = Math.max(220, anchorRect.top - 32);
    setPopoverStyle({
      left,
      top: Math.max(12, anchorRect.top - Math.min(360, availableHeight) - 9),
      width,
      maxHeight: Math.min(360, availableHeight),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePopoverPosition();
    window.addEventListener('resize', updatePopoverPosition);
    window.addEventListener('scroll', updatePopoverPosition, true);
    return () => {
      window.removeEventListener('resize', updatePopoverPosition);
      window.removeEventListener('scroll', updatePopoverPosition, true);
    };
  }, [open, updatePopoverPosition]);

  const toggle = async () => {
    if (!sessionId || disabled) return;
    const next = !open;
    setOpen(next);
    if (!next || skills.length > 0) return;
    setLoading(true);
    setError(null);
    try { setSkills((await api.sessions.skills.list(sessionId)).skills); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  const activate = async () => {
    if (!sessionId || !selected || loading) return;
    setLoading(true);
    setError(null);
    try {
      await api.sessions.skills.activate(sessionId, selected.name, args);
      setOpen(false);
      setSelected(null);
      setArgs('');
      setQuery('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setLoading(false); }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(needle)) : skills;
  }, [query, skills]);

  const popover = open ? createPortal(<div ref={popoverRef} className="skill-popover" style={popoverStyle} role="dialog" aria-label={tr('Skills', '技能')}><header><strong>{tr('Skills', '技能')}</strong><button type="button" onClick={() => setOpen(false)} aria-label={tr('Close', '关闭')}><Icon name="close" size={12}/></button></header><input className="skill-search" value={query} onChange={event => setQuery(event.target.value)} placeholder={tr('Search skills', '搜索技能')} autoFocus/>{loading && skills.length === 0 ? <p>{tr('Loading…', '正在加载…')}</p> : error ? <p className="error">{error}</p> : <div className="skill-list">{visible.map(skill => <button type="button" key={skill.name} className={selected?.name === skill.name ? 'selected' : ''} onClick={() => setSelected(skill)}><strong>/{skill.name}</strong><small>{skill.description}</small></button>)}{visible.length === 0 && <p>{tr('No matching skills', '没有匹配的技能')}</p>}</div>}{selected && <footer><div><strong>/{selected.name}</strong><input value={args} onChange={event => setArgs(event.target.value)} placeholder={tr('Arguments (optional)', '参数（可选）')}/></div><button type="button" onClick={() => void activate()} disabled={loading}>{tr('Run', '运行')}</button></footer>}</div>, document.body) : null;

  return <div className="skill-picker" ref={rootRef}><button type="button" className="composer-skill-button" onClick={() => void toggle()} disabled={!sessionId || disabled} title={tr('Run a skill', '运行技能')} aria-label={tr('Run a skill', '运行技能')} aria-expanded={open}><Icon name="sparkles" size={14}/></button>{popover}</div>;
}
