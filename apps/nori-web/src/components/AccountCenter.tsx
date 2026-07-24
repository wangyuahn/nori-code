import { useState } from 'react';

import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { SettingsPanel } from './SettingsPanel';
import { ProviderSettings } from './ProviderSettings';
import { VaultBrowser } from './VaultBrowser';

type AccountTab = 'settings' | 'providers' | 'memory';
type MemoryMode = 'list' | 'graph';

export function AccountCenter() {
  const { tr } = useI18n();
  const [tab, setTab] = useState<AccountTab>('settings');
  const [memoryMode, setMemoryMode] = useState<MemoryMode>('list');

  return <div className="account-center">
    <header className="account-heading">
      <span className="account-avatar"><Icon name="user" size={23}/></span>
      <span><small>{tr('Personal center', '个人中心')}</small><strong>{tr('My Nori workspace', '我的 Nori 工作区')}</strong><p>{tr('Manage preferences and the durable memory Nori can retrieve.', '统一管理偏好设置与 Nori 可检索的长期记忆。')}</p></span>
    </header>
    <nav className="account-tabs" aria-label={tr('Personal center sections', '个人中心栏目')}>
      <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => {
        setTab('settings');
      }}><Icon name="settings" size={15}/>{tr('Preferences', '偏好设置')}</button>
      <button type="button" className={tab === 'providers' ? 'active' : ''} onClick={() => {
        setTab('providers');
      }}><Icon name="shield" size={15}/>{tr('Providers', '供应商')}</button>
      <button type="button" className={tab === 'memory' ? 'active' : ''} onClick={() => {
        setTab('memory');
      }}><Icon name="vault" size={15}/>{tr('Memory', '记忆库')}</button>
    </nav>
    <div className="account-content">
      {tab === 'settings' ? <SettingsPanel /> : tab === 'providers' ? <ProviderSettings /> : <>
        <div className="account-memory-toolbar">
          <div><strong>{tr('Nori memory', 'Nori 记忆')}</strong><span>{tr('Notes remain compatible with the vault and linked graph.', '笔记继续兼容知识库与双向链接图。')}</span></div>
          <div className="account-memory-modes" role="group" aria-label={tr('Memory view', '记忆视图')}>
            <button type="button" className={memoryMode === 'list' ? 'active' : ''} onClick={() => {
              setMemoryMode('list');
            }}><Icon name="list" size={14}/>{tr('Notes', '笔记')}</button>
            <button type="button" className={memoryMode === 'graph' ? 'active' : ''} onClick={() => {
              setMemoryMode('graph');
            }}><Icon name="graph" size={14}/>{tr('Graph', '关系图')}</button>
          </div>
        </div>
        <VaultBrowser mode={memoryMode}/>
      </>}
    </div>
  </div>;
}
