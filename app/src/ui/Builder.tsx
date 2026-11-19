import { useState } from 'react';
import { codeHash, newBlock, newCode, parse, ParseError, type Block, type Way } from '@nexus-contracts/core/src';
import type { NexusNode } from '../../../../dex/core/src/nexus/node';
import type { Session } from '../lib/chain';
import { copyText, PersonInput, TimeInput, errorText } from './common';

const kindNames: Record<Block['kind'], string> = {
  who: 'Who claims',
  before: 'Before',
  from: 'From',
  decision: 'Arbiter decided',
  secret: 'Code given',
  code: 'Code',
};

const kindHelp: Record<Block['kind'], string> = {
  who: 'only this person can use this way',
  before: 'only before this time (block time)',
  from: 'only from this time on (block time)',
  decision: "the arbiter's decision register says release or refund",
  secret: 'the claimer must enter a code you give them (it goes into their code box)',
  code: 'any other rule, written as code',
};

const dragKind = 'text/x-contract-block';
const dragMove = 'text/x-contract-move';

interface Props {
  node: NexusNode;
  session: Session;
  ways: Way[];
  setWays: (w: Way[]) => void;
  names: Map<string, string>;
  onName: (genesis: string, label: string) => void;
}

export function Builder({ node, session, ways, setWays, names, onName }: Props) {
  const [focus, setFocus] = useState(0);
  const [over, setOver] = useState<number | null>(null);

  const update = (wi: number, fn: (w: Way) => Way) => setWays(ways.map((w, i) => (i === wi ? fn(w) : w)));
  const setBlock = (wi: number, bi: number, b: Block) => update(wi, (w) => w.map((x, i) => (i === bi ? b : x)));
  const removeBlock = (wi: number, bi: number) => update(wi, (w) => w.filter((_, i) => i !== bi));
  const addBlock = (wi: number, kind: Block['kind']) => {
    const list = ways.length ? ways : [[]];
    const target = Math.min(wi, list.length - 1);
    setWays(list.map((w, i) => (i === target ? [...w, newBlock(kind)] : w)));
  };

  const drop = (wi: number | 'new', e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const kind = e.dataTransfer.getData(dragKind) as Block['kind'];
    const move = e.dataTransfer.getData(dragMove);
    let list = ways.map((w) => [...w]);
    let block: Block | undefined;
    if (move) {
      const [fw, fb] = move.split(':').map(Number) as [number, number];
      block = list[fw]?.[fb];
      if (!block || fw === wi) {
        return;
      }
      list[fw] = list[fw]!.filter((_, i) => i !== fb);
    } else if (kind) {
      block = newBlock(kind);
    }
    if (!block) {
      return;
    }
    if (wi === 'new') {
      list.push([block]);
      setFocus(list.length - 1);
    } else {
      list[wi] = [...list[wi]!, block];
    }
    //a way emptied by a move goes away, unless it is the only one
    list = list.filter((w, i) => w.length > 0 || i === wi || list.length === 1);
    setWays(list);
  };

  return (
    <div>
      <div className="palette">
        <span className="muted" style={{ fontSize: 12 }}>
          Drag a block into a way, or click to add it to the selected way:
        </span>
        {(['who', 'before', 'from', 'decision', 'secret', 'code'] as Block['kind'][]).map((k) => (
          <button key={k} className={`chip ${k}`} draggable title={kindHelp[k]} onDragStart={(e) => e.dataTransfer.setData(dragKind, k)} onClick={() => addBlock(focus, k)}>
            + {kindNames[k]}
          </button>
        ))}
      </div>

      {ways.map((way, wi) => (
        <div key={wi}>
          {wi > 0 && <div className="or">OR</div>}
          <div
            className={`way ${over === wi ? 'over' : ''} ${focus === wi ? 'focus' : ''}`}
            onClick={() => setFocus(wi)}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(wi);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => drop(wi, e)}
          >
            <div className="way-head">
              <b>Way {wi + 1} to claim</b>
              <span>all blocks must be true</span>
              <span className="end">
                {ways.length > 1 && (
                  <button className="small" onClick={() => setWays(ways.filter((_, i) => i !== wi))}>
                    Remove way
                  </button>
                )}
              </span>
            </div>
            {way.length === 0 && <div className="drop-hint">Drop blocks here</div>}
            {way.map((b, bi) => (
              <div key={bi}>
                {bi > 0 && <div className="and">AND</div>}
                <BlockEditor node={node} session={session} block={b} names={names} onName={onName} onChange={(nb) => setBlock(wi, bi, nb)} onRemove={() => removeBlock(wi, bi)} dragId={`${wi}:${bi}`} />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="or">OR</div>
      <div
        className={`drop-hint ${over === -1 ? 'way over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(-1);
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => drop('new', e)}
      >
        Drop a block here for a new way, or{' '}
        <button
          className="link"
          onClick={() => {
            setWays([...ways, []]);
            setFocus(ways.length);
          }}
        >
          add an empty way
        </button>
      </div>
    </div>
  );
}

function BlockEditor(props: { node: NexusNode; session: Session; block: Block; names: Map<string, string>; onName: (g: string, l: string) => void; onChange: (b: Block) => void; onRemove: () => void; dragId: string }) {
  const { block: b, onChange, names } = props;
  const label = (g: string) => (g ? (g === props.session.genesis ? props.session.username : (names.get(g) ?? g)) : '');
  return (
    <div className={`block ${b.kind}`}>
      <span className="grip" draggable title="Drag to another way" onDragStart={(e) => e.dataTransfer.setData(dragMove, props.dragId)}>
        ::
      </span>
      <span className="kind" title={kindHelp[b.kind]}>
        {kindNames[b.kind]}
      </span>
      {b.kind === 'who' && (
        <PersonInput
          node={props.node}
          session={props.session}
          value={label(b.genesis)}
          onPerson={(p, text) => {
            if (p) {
              props.onName(p.genesis, p.username ?? text);
            }
            onChange({ kind: 'who', genesis: p?.genesis ?? '' });
          }}
        />
      )}
      {(b.kind === 'before' || b.kind === 'from') && <TimeInput value={b.time} onChange={(time) => onChange({ ...b, time })} />}
      {b.kind === 'decision' && (
        <>
          <PersonInput
            node={props.node}
            session={props.session}
            value={label(b.arbiter)}
            placeholder="arbiter"
            className=""
            onPerson={(p, text) => {
              if (p) {
                props.onName(p.genesis, p.username ?? text);
              }
              onChange({ ...b, arbiter: p?.genesis ?? '' });
            }}
          />
          <input placeholder="escrow id" value={b.id} onChange={(e) => onChange({ ...b, id: e.target.value.toLowerCase() })} style={{ width: 130 }} spellCheck={false} />
          <select value={b.value} onChange={(e) => onChange({ ...b, value: Number(e.target.value) })}>
            <option value={1}>release</option>
            <option value={2}>refund</option>
          </select>
        </>
      )}
      {b.kind === 'secret' && (
        <>
          <PersonInput
            node={props.node}
            session={props.session}
            value={label(b.genesis)}
            placeholder="whose code box"
            className=""
            onPerson={(p, text) => {
              if (p) {
                props.onName(p.genesis, p.username ?? text);
              }
              onChange({ ...b, genesis: p?.genesis ?? '' });
            }}
          />
          {b.code ? (
            <span className="row">
              <b style={{ fontFamily: 'var(--mono)' }}>{b.code}</b>
              <button className="small" onClick={() => copyText(b.code!)}>
                Copy
              </button>
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              code not on this device (hash {b.hash.slice(0, 8)}...)
            </span>
          )}
          <button
            className="small"
            onClick={() => {
              const code = newCode();
              onChange({ ...b, code, hash: Array.from(codeHash(code), (x) => x.toString(16).padStart(2, '0')).join('') });
            }}
          >
            New code
          </button>
        </>
      )}
      {b.kind === 'code' && <CodeBlock text={b.text} onChange={(text) => onChange({ kind: 'code', text })} />}
      <button className="x" onClick={props.onRemove} aria-label="Remove block" title="Remove block">
        x
      </button>
    </div>
  );
}

function CodeBlock({ text, onChange }: { text: string; onChange: (t: string) => void }) {
  let error = '';
  try {
    parse(text);
  } catch (e) {
    error = e instanceof ParseError ? `${e.message} (at ${e.pos + 1})` : errorText(e);
  }
  return (
    <>
      <input className="code" value={text} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      {error && <span className="bad" style={{ fontSize: 12 }}>{error}</span>}
    </>
  );
}
