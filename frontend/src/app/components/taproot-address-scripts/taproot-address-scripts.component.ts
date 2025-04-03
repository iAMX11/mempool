import { Component, ChangeDetectionStrategy, Input, OnChanges, NgZone, SimpleChanges, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { Location } from '@angular/common';
import { AddressTypeInfo } from '@app/shared/address-utils';
import { EChartsOption } from '@app/graphs/echarts';
import { ScriptInfo } from '@app/shared/script.utils';
import { compactSize, taggedHash, uint8ArrayToHexString } from '@app/shared/transaction.utils';
import { StateService } from '@app/services/state.service';
import { AsmStylerPipe } from '@app/shared/pipes/asm-styler/asm-styler.pipe';
import { RelativeUrlPipe } from '../../shared/pipes/relative-url/relative-url.pipe';

interface TaprootTree {
  name: string; // the TapBranch hash or TapLeaf script hash
  value?: {
    leafVersion: number;
    script: ScriptInfo;
  };
  depth?: number;
  children?: [TaprootTree, TaprootTree];
  // ECharts properties
  symbol?: string;
  symbolSize?: number;
  symbolOffset?: number[];
  label?: any;
  tooltip?: { label: string, content?: string }[];
}

@Component({
  selector: 'app-taproot-address-scripts',
  templateUrl: './taproot-address-scripts.component.html',
  styleUrls: ['./taproot-address-scripts.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaprootAddressScriptsComponent implements OnChanges {
  @Input() address: AddressTypeInfo;

  tree: TaprootTree;
  croppedTree: TaprootTree;
  croppedTreeDepth: number = 7;
  depth: number = 0;
  depthShown: number;
  height: number;
  levelHeight: number = 40;
  fullTreeShown: boolean;

  chartOptions: EChartsOption = {};
  chartInitOptions = {
    renderer: 'svg',
  };
  chartInstance: any;
  isTouchscreen: boolean = 'ontouchstart' in window || navigator.maxTouchPoints > 0 || (navigator as any).msMaxTouchPoints > 0;

  constructor(
    public stateService: StateService,
    private asmStylerPipe: AsmStylerPipe,
    private cd: ChangeDetectorRef,
    private location: Location,
    private relativeUrlPipe: RelativeUrlPipe,
    private router: Router,
    private zone: NgZone,
  ) { }

  ngOnChanges(changes: SimpleChanges) {
    if (changes.address?.currentValue.scripts) {
      this.buildTree();
      this.prepareTree(this.tree, 0);
      this.cropTree();
      this.toggleTree(this.fullTreeShown, false);
    }
  }

  buildTree(): void {
    if (this.address?.scripts.size) {
      for (const script of this.address.scripts.values()) {
        let { leafVersion, merklePath } = this.parseControlBlock(script.scriptPath);
        this.tree = this.addPathToTree(this.tree, script, leafVersion, merklePath);
      }
    }
  }

  cropTree(): void {
    const cropNode = (node: TaprootTree, currentDepth: number) => {
      if (!node) {
        return;
      }
      if (currentDepth === this.croppedTreeDepth && node.children) {
        delete node.children;
        return;
      }
      if (node.children) {
        cropNode(node.children[0], currentDepth + 1);
        cropNode(node.children[1], currentDepth + 1);
      }
    };
    this.croppedTree = JSON.parse(JSON.stringify(this.tree));
    cropNode(this.croppedTree, 0);
  }

  toggleTree(show: boolean, delay = true): void {
    this.fullTreeShown = show;
    this.depthShown = show ? this.depth : Math.min(this.depth, this.croppedTreeDepth);
    if (show) {
      this.height = (this.depthShown + 1) * this.levelHeight;
      setTimeout(() => {
        this.prepareChartOptions(this.tree);
        this.cd.markForCheck();
      }, 115);
    } else {
      this.prepareChartOptions(this.croppedTree);
      if (!delay) {
        this.height = (this.depthShown + 1) * this.levelHeight;
      } else {
        setTimeout(() => {
          this.height = (this.depthShown + 1) * this.levelHeight;
          this.cd.markForCheck();
        }, 200);
      }
    }
  }

  parseControlBlock(controlBlock: string): { leafVersion: number, merklePath: string[] } {

    const m = ((controlBlock.length / 2) - 33) / 32;
    if (!Number.isInteger(m)) {
      throw new Error("Invalid scriptPath: length does not match the expected format.");
    }

    const leafVersion = parseInt(controlBlock.slice(0, 2), 16) & 0xfe;
    const merklePath = [];
    for (let i = 0; i < m; i++) {
      merklePath.push(controlBlock.slice(66 + i * 64, 66 + (i + 1) * 64));
    }

    if (merklePath.length > this.depth) {
      this.depth = merklePath.length;
    }

    return { leafVersion, merklePath };
  }

  addPathToTree(masterTree: TaprootTree, script: ScriptInfo, leafVersion: number, merklePath: string[]): TaprootTree {
    // See https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki
    let k = taggedHash('TapLeaf', leafVersion.toString(16) + uint8ArrayToHexString(compactSize(script.hex.length / 2)) + script.hex);
    let node: TaprootTree = { name: k, value: { leafVersion, script } };

    // Start from the leaf and go up until we can merge in the current tree
    for (let i = 0; i < merklePath.length; i++) {
      const e = merklePath[i];
      const [left, right] = [k, e].sort((a, b) => a.localeCompare(b));
      const parentHash = taggedHash('TapBranch', left + right);
      const isFirstChild = left === k;
      const children: [TaprootTree, TaprootTree] = isFirstChild ? [node, { name: e }] : [{ name: e }, node];

      // Try to merge the branch to the tree at current level
      if (masterTree && this.mergeBranchAtDepth(masterTree, parentHash, children, isFirstChild, merklePath.length - i - 1)) {
        return masterTree;
      }
      // If no merge is possible, go up one level and try again
      k = parentHash;
      node = { name: k, children };
    }

    if (!masterTree) {
      return node;
    }
    // We only end up here if we could not merge the script in masterTree due to malformed merkle path
    console.error('Could not merge script in Taptree');
  }

  mergeBranchAtDepth(tree: TaprootTree, target: string, children: [TaprootTree, TaprootTree], first: boolean, targetDepth: number, currentDepth = 0): boolean {
    if (!tree) {
      return false;
    }

    if (currentDepth === targetDepth) {
      if (tree.name === target) {
        if (!tree.children) {
          tree.children = children;
        } else {
          if (first) {
            tree.children[0] = children[0];
          } else {
            tree.children[1] = children[1];
          }
        }
        return true;
      }
      return false;
    }

    if (tree.children) {
      for (const child of tree.children) {
        if (this.mergeBranchAtDepth(child, target, children, first, targetDepth, currentDepth + 1)) {
          return true;
        }
      }
    }
    return false;
  }

  prepareTree(node: TaprootTree, depth: number): void {
    if (!node) {
      return;
    }

    node.depth = depth;
    node.symbol = 'none';

    const basePillStyle = {
      align: 'center',
      padding: [3, 6],
      borderRadius: 10,
      fontSize: 10,
      fontWeight: 'bold',
      fontFamily: 'system-ui',
    };

    if (depth === 0) {
      node.symbol = 'none';
      node.label = {
        formatter: '{pill|Taproot}',
        offset: [0, -5],
        rich: {
          pill: {
            ...basePillStyle,
            backgroundColor: 'var(--tertiary)',
            color: '#fff',
          },
        },
      };
      node.tooltip = [
        { label: 'TapRoot Hash', content: node.name.slice(0, 10) + '…' + node.name.slice(-10) },
      ];
    }

    if (node.children) {
      if (depth > 0) {
        node.symbol = 'circle';
        node.symbolSize = 10;
        node.symbolOffset = [0, 5];
        node.label = { formatter: '' };
        node.tooltip = [
          { label: 'TapBranch Hash', content: node.name.slice(0, 10) + '…' + node.name.slice(-10) },
          { label: 'Depth', content: depth.toString() },
        ];
      }
      this.prepareTree(node.children[0], depth + 1);
      this.prepareTree(node.children[1], depth + 1);
    } else {
      if (node.value) {
        const script = node.value.script;
        const label = script.template?.label;

        node.label = {
          formatter: `{pill|${label || 'Script'}}`,
          offset: [0, 5],
          verticalAlign: 'middle',
          rich: {
            pill: {
              ...basePillStyle,
              backgroundColor: '#ffc107',
              color: '#212529'
            }
          }
        };

        node.tooltip = [
          { label: 'TapLeaf Hash', content: node.name.slice(0, 10) + '…' + node.name.slice(-10) },
          { label: 'Depth', content: depth.toString() },
          { label: 'Leaf Version', content: node.value.leafVersion.toString(16) },
        ];

      } else {
        node.symbol = 'circle';
        node.symbolSize = 10;
        node.symbolOffset = [0, 5];
        node.label = { formatter: '' };
        node.tooltip = [
          { label: 'Hash', content: node.name.slice(0, 10) + '…' + node.name.slice(-10) },
          { label: 'Depth', content: depth.toString() },
        ];
      }
    }
  }

  prepareChartOptions(tree: TaprootTree) {
    if (!tree) {
      return;
    }

    this.chartOptions = {
      tooltip: {
        show: true,
        backgroundColor: 'rgba(17, 19, 31, 1)',
        borderRadius: 4,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        confine: true,
        textStyle: {
          color: '#b1b1b1',
        },
        borderColor: '#000',
        formatter: (params: any) => {
          const node: TaprootTree = params.data;
          if (!node.tooltip) {
            return '';
          }

          let rows = node.tooltip.map(
            (item) =>
              `<tr>
                  <td style="color: #fff; padding-right: 5px; width: 30%">${item.label}</td>
                  <td style="color: #b1b1b1; text-align: right">${item.content}</td>
                </tr>`
          ).join('');

          if (node.value?.script.vinId) {
            const [txid, vinIndex] = node.value.script.vinId.split(':');
            rows += `
              <tr>
                <td style="color: #fff; padding-right: 5px; width: 30%">Last used in tx</td>
                <td style="color: #b1b1b1; text-align: right">
                  <a href="${this.relativeUrlPipe.transform('/tx/' + txid)}?mode=details#vin=${vinIndex}">${txid.slice(0, 10) + '…' + txid.slice(-10)}</a>
                </td>
              </tr>`;
          }

          let asmContent = '';
          if (node.value?.script?.asm) {
            const asm = this.asmStylerPipe.transform(node.value.script.asm, 300);
            asmContent = `
              <div style="margin-top: 10px; border-top: 1px solid #333; padding-top: 5px; word-break: break-all; white-space: normal; font-family: monospace; font-size: 12px;">
                <td>${asm} ${node.value.script.asm.length > 300 ? '...' : ''}</td>
              </div>`;
          }

          let hiddenScriptsMessage = '';
          if (node.tooltip[0].label === 'Hash') {
            hiddenScriptsMessage = `
              <div style="margin-top: 8px; color: #888; font-size: 11px; line-height: 1.3; font-style: italic; border-top: 1px solid #333; padding-top: 6px; word-break: break-word; white-space: normal">
                This node might commit to one or more scripts that have not been revealed yet.
              </div>`;
          }

          return `
            <div style="max-width: 300px; pointer-events: auto;"">
              <table style="width: 100%; table-layout: fixed;">
                <tbody>${rows}</tbody>
              </table>
              ${asmContent}
              ${hiddenScriptsMessage}
            </div>`;
        },
      },
      series: [{
        type: 'tree',
        data: [tree as any],
        top: '20',
        bottom: '20',
        right: 0,
        left: 0,
        height: Math.max(140, this.depthShown * this.levelHeight),
        lineStyle: {
          curveness: 0.9,
          width: 2,
        },
        emphasis: {
          focus: 'ancestor',
          itemStyle: {
            color: '#ccc',
          },
          lineStyle: {
            color: '#ccc',
          }
        },
        orient: 'TB',
        expandAndCollapse: false,
        animationDuration: 250,
        animationDurationUpdate: 250,
      }],
    };
  }

  onChartInit(ec) {
    this.chartInstance = ec;
    this.chartInstance.on('click', 'series', this.onChartClick.bind(this));
  }

  onChartClick(e): void {
    if (this.isTouchscreen) { // show tooltip on touchscreen, and click on link in tooltip to navigate
      return;
    }

    if (!e.data.value?.script.vinId) {
      return;
    }

    const [txid, vinIndex] = e.data.value.script.vinId.split(':');
    const url = this.router.createUrlTree([this.relativeUrlPipe.transform('/tx'), txid], { fragment: 'vin=' + vinIndex });

    this.zone.run(() => {
      if (e.event?.event?.ctrlKey || e.event?.event?.metaKey) {
        const fullUrl = this.location.prepareExternalUrl(this.router.serializeUrl(url));
        window.open(fullUrl, '_blank');
      } else {
        this.router.navigate([this.relativeUrlPipe.transform('/tx'), txid], { fragment: 'vin=' + vinIndex });
      }
    });

  }
}