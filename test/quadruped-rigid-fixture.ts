// A small synthetic quadruped-rigid rig (#128) for the ordinary test gate, which runs without hydrated LFS payloads.
import { Document, type Mesh, type Node } from "@gltf-transform/core";

/** One box mesh spanning the given corners, indexed as twelve triangles. */
function box(document: Document, name: string, min: [number, number, number], max: [number, number, number]): Mesh {
  const positions: number[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) positions.push(x, y, z);
  const buffer = document.getRoot().listBuffers()[0]!;
  const position = document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer);
  const indices = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  const index = document.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(index);
  return document.createMesh(name).addPrimitive(primitive);
}

export type QuadrupedOptions = { name?: string; legs?: readonly string[]; neck?: boolean; wings?: boolean; height?: number };
export type Quadruped = { document: Document; nodes: Map<string, Node>; rootNode: Node };

const LEG_LAYOUT = [[-0.4, 0.2], [-0.4, -0.2], [0.4, 0.2], [0.4, -0.2]] as const;
const BIPED_LEG_LAYOUT = [[0, 0.1], [0, -0.1]] as const;

/** A grounded rig (four legs, or two legs and `wings` for biped-rigid) with the required joints and the two required clips, at y = 0 and centred on the origin. */
export function quadruped({ name = "test-animal", legs = ["leg_0", "leg_1", "leg_2", "leg_3"], neck = false, wings = false, height = 0.6 }: QuadrupedOptions = {}): Quadruped {
  const layout = legs.length === 2 ? BIPED_LEG_LAYOUT : LEG_LAYOUT;
  const document = new Document();
  document.createBuffer();
  const nodes = new Map<string, Node>();
  const add = (nodeName: string, parent: Node | null, translation: [number, number, number], mesh: Mesh | null) => {
    const node = document.createNode(nodeName).setTranslation(translation);
    if (mesh) node.setMesh(mesh);
    parent?.addChild(node);
    nodes.set(nodeName, node);
    return node;
  };
  const rootNode = add("animal_root", null, [0, 0, 0], null);
  document.createScene("Scene").addChild(rootNode);
  add("body", rootNode, [0, height, 0], box(document, "body", [-0.5, -0.1, -0.15], [0.5, 0.15, 0.15]));
  const head = neck ? add("neck", rootNode, [0.5, height, 0], box(document, "neck", [-0.05, 0, -0.05], [0.05, 0.5, 0.05])) : null;
  add("head", head ?? rootNode, head ? [0, 0.5, 0] : [0.6, height, 0], box(document, "head", [0, -0.1, -0.1], [0.2, 0.1, 0.1]));
  add("tail", rootNode, [-0.55, height, 0], box(document, "tail", [-0.2, -0.01, -0.01], [0, 0.01, 0.01]));
  legs.forEach((leg, index) => add(leg, rootNode, [layout[index]![0], height, layout[index]![1]], box(document, leg, [-0.05, -height, -0.05], [0.05, 0, 0.05])));
  if (wings) for (const [wing, side] of [["wing_left", 1], ["wing_right", -1]] as const) {
    add(wing, rootNode, [0.2, height + 0.1, 0.15 * side], box(document, wing, [-0.4, -0.08, side > 0 ? 0 : -0.02], [0, 0, side > 0 ? 0.02 : 0]));
  }

  const key = document.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 0.5, 1])).setBuffer(document.getRoot().listBuffers()[0]!);
  const channel = (node: string, channelPath: "translation" | "rotation", values: number[]) => {
    const output = document.createAccessor().setType(channelPath === "rotation" ? "VEC4" : "VEC3").setArray(new Float32Array(values)).setBuffer(document.getRoot().listBuffers()[0]!);
    const sampler = document.createAnimationSampler().setInput(key).setOutput(output).setInterpolation("LINEAR");
    return document.createAnimationChannel().setTargetNode(nodes.get(node)!).setTargetPath(channelPath).setSampler(sampler);
  };
  const clip = (clipName: string) => document.createAnimation(clipName);
  const idle = clip("idle");
  const idleChannel = channel("animal_root", "translation", [0, 0, 0, 0, 0.03, 0, 0, 0, 0]);
  idle.addChannel(idleChannel).addSampler(idleChannel.getSampler()!);
  const walk = clip("walk");
  for (const leg of legs) {
    const swing = channel(leg, "rotation", [0, 0, 0, 1, 0.17, 0, 0, 0.985, 0, 0, 0, 1]);
    walk.addChannel(swing).addSampler(swing.getSampler()!);
  }
  return { document, nodes, rootNode };
}
