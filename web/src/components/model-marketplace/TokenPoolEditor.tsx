import { KeyRound, Plus, RotateCcw, Trash2 } from 'lucide-react'

import { confirmLocalized } from '../../i18n'
import { SecretActionField } from './SecretActionField'
import type { TokenDraftRow } from './types'

let nextTokenKey = 1

export function newTokenRow(): TokenDraftRow {
  return { key: nextTokenKey++, kind: 'new', name: '', action: 'replace', value: '' }
}

export function existingTokenRow(id: string, name: string): TokenDraftRow {
  return { key: nextTokenKey++, kind: 'existing', id, name, action: 'keep', value: '' }
}

export function TokenPoolEditor({
  rows,
  onChange,
}: {
  rows: TokenDraftRow[]
  onChange: (rows: TokenDraftRow[]) => void
}) {
  const update = (key: number, updater: (row: TokenDraftRow) => TokenDraftRow) =>
    onChange(rows.map((row) => (row.key === key ? updater(row) : row)))
  return (
    <section className="token-pool-editor">
      <header>
        <div>
          <KeyRound size={17} />
          <span>
            <b>Bearer Token 池</b>
            <small>Token 属于 Provider，不属于逻辑模型。</small>
          </span>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => onChange([...rows, newTokenRow()])}
        >
          <Plus size={14} /> 新增 Token
        </button>
      </header>
      {rows.length === 0 && (
        <p className="editor-empty">尚未添加 Token。选择无凭据调用前需要显式确认。</p>
      )}
      {rows.map((row) => (
        <div className={`token-draft-row action-${row.action}`} key={row.key}>
          <label>
            <span>Token 名</span>
            <input
              value={row.name}
              disabled={row.kind === 'existing'}
              onChange={(event) =>
                update(row.key, (current) =>
                  current.kind === 'new' ? { ...current, name: event.target.value } : current,
                )
              }
            />
          </label>
          {row.kind === 'existing' && row.action === 'keep' && (
            <div className="token-row-actions">
              <span>保留已保存凭据</span>
              <button
                type="button"
                onClick={() =>
                  update(row.key, () => ({
                    key: row.key,
                    kind: 'existing',
                    id: row.id,
                    name: row.name,
                    action: 'replace',
                    value: '',
                  }))
                }
              >
                <RotateCcw size={14} /> 替换
              </button>
              <button
                type="button"
                onClick={() =>
                  confirmLocalized(
                    `从当前草稿删除 Token“${row.name}”？历史 release 不会被改写。`,
                  ) &&
                  update(row.key, () => ({
                    key: row.key,
                    kind: 'existing',
                    id: row.id,
                    name: row.name,
                    action: 'delete',
                    value: '',
                  }))
                }
              >
                <Trash2 size={14} /> 删除
              </button>
            </div>
          )}
          {row.action === 'replace' && (
            <div>
              <SecretActionField
                label={row.kind === 'existing' ? '新 Token 值' : 'Token 值'}
                value={row.value}
                onChange={(value) =>
                  update(row.key, (current) =>
                    current.action === 'replace' ? { ...current, value } : current,
                  )
                }
              />
              {row.kind === 'existing' && (
                <button
                  className="cancel-secret-replace"
                  type="button"
                  onClick={() =>
                    update(row.key, () => ({
                      key: row.key,
                      kind: 'existing',
                      id: row.id,
                      name: row.name,
                      action: 'keep',
                      value: '',
                    }))
                  }
                >
                  保留原凭据并清空新输入
                </button>
              )}
            </div>
          )}
          {row.action === 'delete' && (
            <div className="token-delete-confirmation">
              <span>保存后将从当前草稿移除此凭据，历史 release 不会被改写。</span>
              <button
                type="button"
                onClick={() =>
                  update(row.key, () => ({
                    key: row.key,
                    kind: 'existing',
                    id: row.id,
                    name: row.name,
                    action: 'keep',
                    value: '',
                  }))
                }
              >
                撤销删除
              </button>
            </div>
          )}
          {row.kind === 'new' && (
            <button
              className="remove-token-button"
              type="button"
              onClick={() => onChange(rows.filter((candidate) => candidate.key !== row.key))}
            >
              移除此行
            </button>
          )}
        </div>
      ))}
    </section>
  )
}
