"use client"

import { useMemo } from "react"
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import type { AgentType } from "@agent-desk/schemas"
import { NodeCard } from "./node-card.tsx"

/**
 * FR-17: the chain, left to right, with `@xyflow/react`.
 *
 * The graph is a view, not the model — the Builder edits the chain in the
 * inspector below it and this redraws. Dragging, connecting and zooming are all
 * off on purpose: a linear chain has exactly one shape, and on a projector a
 * graph that can be knocked out of place is a liability. Clicking a Node
 * selects it, which is how the Provider picker follows the graph.
 */

export interface ChainGraphNode {
  index: number
  type: AgentType
  provider: string | null
  price: string | null
  violations: readonly string[]
}

type ChainNodeData = {
  index: number
  type: AgentType
  provider: string | null
  price: string | null
  violations: readonly string[]
  isSelected: boolean
}

const NODE_SPACING = 320

function ChainFlowNode({ data }: NodeProps<Node<ChainNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Left} className="!bg-border" />
      <NodeCard
        index={data.index}
        type={data.type}
        provider={data.provider}
        price={data.price}
        violations={data.violations}
        selected={data.isSelected}
      />
      <Handle type="source" position={Position.Right} className="!bg-border" />
    </>
  )
}

const NODE_TYPES: NodeTypes = { chain: ChainFlowNode }

export function ChainGraph({
  nodes,
  selectedIndex,
  onSelect,
}: {
  nodes: readonly ChainGraphNode[]
  selectedIndex: number | null
  onSelect: (index: number) => void
}) {
  const flowNodes = useMemo<Node<ChainNodeData>[]>(
    () =>
      nodes.map((node) => ({
        id: String(node.index),
        type: "chain",
        position: { x: node.index * NODE_SPACING, y: 0 },
        draggable: false,
        data: {
          index: node.index,
          type: node.type,
          provider: node.provider,
          price: node.price,
          violations: node.violations,
          isSelected: node.index === selectedIndex,
        },
      })),
    [nodes, selectedIndex],
  )

  const flowEdges = useMemo<Edge[]>(
    () =>
      nodes.slice(1).map((node) => ({
        id: `${node.index - 1}->${node.index}`,
        source: String(node.index - 1),
        target: String(node.index),
        animated: true,
        style: { strokeWidth: 3 },
      })),
    [nodes],
  )

  if (nodes.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-xl border-2 border-dashed border-border text-lg text-muted-foreground">
        Add a Node to start the chain.
      </div>
    )
  }

  return (
    <div className="h-[300px] w-full overflow-hidden rounded-xl ring-1 ring-border">
      <ReactFlow
        // Remounting on a change of length is what re-runs `fitView`, so a Node
        // added at the far right of the chain is always in view.
        key={nodes.length}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.2}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        panOnScroll={false}
        preventScrolling={false}
        onNodeClick={(_event, node) => onSelect(Number(node.id))}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
      </ReactFlow>
    </div>
  )
}
