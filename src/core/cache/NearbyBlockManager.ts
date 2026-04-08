/**
 * 附近方块管理器
 * 提供智能的方块信息收集和格式化展示
 * 参考 maicraft 项目的 nearby_block.py 实现
 */

import { getLogger } from '@/utils/Logger';
import type { Logger } from '@/utils/Logger';
import type { BlockCache } from './BlockCache';
import type { BlockInfo } from './types';
import type { Bot } from 'mineflayer';

/**
 * 方块位置
 */
export interface BlockPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * 地形分析结果
 */
interface TerrainAnalysis {
  obstacles: string[]; // 障碍物描述
  structures: string[]; // 结构描述
  resources: string[]; // 资源描述
  environment: string[]; // 环境描述
}

/**
 * 附近方块管理器
 */
export class NearbyBlockManager {
  private logger: Logger;
  private isValidPosition(position: BlockPosition | null | undefined): position is BlockPosition {
    return !!position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
  }

  private blockCache: BlockCache;
  private bot: Bot | null = null;

  constructor(blockCache: BlockCache, bot?: Bot) {
    this.logger = getLogger('NearbyBlockManager');
    this.blockCache = blockCache;
    this.bot = bot || null;
  }

  /**
   * 设置bot实例（用于获取视角等信息）
   */
  setBot(bot: Bot): void {
    this.bot = bot;
  }

  /**
   * 获取可见方块的字符串表示
   * @param position 中心位置
   * @param distance 搜索距离
   * @returns 格式化的方块信息字符串
   */
  getVisibleBlocksInfo(position: BlockPosition, distance: number = 16): string {
    try {
      if (!this.isValidPosition(position)) {
        return '位置信息无效，暂时无法查询附近方块';
      }

      if (position.x === 0 && position.y === 0 && position.z === 0 && this.blockCache.size() === 0) {
        this.logger.debug('跳过原点空缓存查询，等待玩家位置和扫描初始化');
        return '玩家位置/方块缓存尚未初始化，等待扫描更新...';
      }

      // 🆕 获取距离范围内的所有方块（如果启用onlyVisibleBlocks，这些方块都是可见的）
      const blocks = this.blockCache.getBlocksInRadius(position.x, position.y, position.z, distance);

      // 详细统计
      const cacheSize = this.blockCache.size();
      const blockTypes = new Map<string, number>();
      for (const b of blocks) {
        const count = blockTypes.get(b.name) || 0;
        blockTypes.set(b.name, count + 1);
      }
      const topTypes = Array.from(blockTypes.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name}:${count}`)
        .join(', ');

      if (blocks.length < 100) {
        this.logger.warn(
          `⚠️ 查询结果少: 位置(${position.x},${position.y},${position.z}) 半径${distance} 找到${blocks.length}个 缓存总数${cacheSize} 类型[${topTypes}]`,
        );
      } else {
        this.logger.debug(`查询缓存: 位置(${position.x},${position.y},${position.z}) 半径${distance} 找到${blocks.length}个`);
      }

      if (blocks.length === 0) {
        return `在半径${distance}格内未找到方块信息，缓存总数${cacheSize}，等待扫描更新...`;
      }

      // 按方块类型分组
      const groupedBlocks = this.groupBlocksByType(blocks, position);

      // 执行地形分析
      const terrain = this.analyzeTerrain(position, groupedBlocks, blocks);

      // 格式化输出
      const lines: string[] = [];

      // 地形分析结果
      if (terrain.environment.length > 0) {
        lines.push('【环境状况】');
        terrain.environment.forEach(line => lines.push(line));
        lines.push('');
      }

      // 障碍物和结构信息
      if (terrain.obstacles.length > 0 || terrain.structures.length > 0) {
        lines.push('【地形分析】');
        terrain.obstacles.forEach(line => lines.push(line));
        terrain.structures.forEach(line => lines.push(line));
        lines.push('');
      }

      // 资源信息
      if (terrain.resources.length > 0) {
        lines.push('【资源分布】');
        terrain.resources.forEach(line => lines.push(line));
        lines.push('');
      }

      // 方块分布（精简版本）
      lines.push('【方块分布】');
      const blockLines = this.formatGroupedBlocks(groupedBlocks);
      if (blockLines.length > 0) {
        lines.push(...blockLines);
      } else {
        lines.push('  周围都是空气');
      }

      return lines.join('\n');
    } catch (error) {
      this.logger.error('获取可见方块信息失败', undefined, error as Error);
      return `获取方块信息失败: ${error instanceof Error ? error.message : '未知错误'}`;
    }
  }

  /**
   * 地形分析 - 智能分析周围环境
   */
  private analyzeTerrain(position: BlockPosition, groupedBlocks: Record<string, BlockInfo[]>, allBlocks: BlockInfo[]): TerrainAnalysis {
    const obstacles: string[] = [];
    const structures: string[] = [];
    const resources: string[] = [];
    const environment: string[] = [];

    // 1. 分析当前位置状态
    const blockAtFeet = this.blockCache.getBlock(position.x, position.y, position.z);
    const blockBelow = this.blockCache.getBlock(position.x, position.y - 1, position.z);
    const blockAbove = this.blockCache.getBlock(position.x, position.y + 1, position.z);

    // 检查是否在水中/岩浆中
    if (blockAtFeet?.name === 'water') {
      environment.push('警告：正在水中！移动速度降低，注意氧气值');
    } else if (blockAtFeet?.name === 'lava') {
      environment.push('危险：正在岩浆中！立即离开！');
    }

    // 坠落检测已移至GameState.onGround，不在此处进行方块检测

    // 2. 分析周围水体/岩浆
    const waterBlocks = groupedBlocks['water'] || [];
    const lavaBlocks = groupedBlocks['lava'] || [];
    if (waterBlocks.length > 100) {
      environment.push(`周围大量水体(${waterBlocks.length}个)，位于海洋/湖泊/河流中`);
    } else if (waterBlocks.length > 10) {
      environment.push(`附近有水体(${waterBlocks.length}个)`);
    }
    if (lavaBlocks.length > 0) {
      environment.push(`警告：附近有岩浆(${lavaBlocks.length}个)，小心！`);
    }

    // 3. 分析视线方向的障碍物
    if (this.bot) {
      const viewAnalysis = this.analyzeViewDirection(position, allBlocks);
      if (viewAnalysis) {
        obstacles.push(viewAnalysis);
      }
    }

    // 4. 分析高度变化（地形起伏）
    const heightAnalysis = this.analyzeHeightVariation(position, allBlocks);
    if (heightAnalysis) {
      structures.push(heightAnalysis);
    }

    // 5. 分析障碍物簇（使用连通性分析）
    const obstacleAnalysis = this.analyzeObstacleClusters(position, groupedBlocks);
    obstacles.push(...obstacleAnalysis);

    // 6. 分析资源分布
    const resourceTypes = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore'];
    const oreInfo: string[] = [];
    for (const ore of resourceTypes) {
      const oreBlocks = groupedBlocks[ore] || [];
      if (oreBlocks.length > 0) {
        const nearest = oreBlocks.reduce(
          (closest, block) => {
            const dist = Math.sqrt(
              Math.pow(block.position.x - position.x, 2) + Math.pow(block.position.y - position.y, 2) + Math.pow(block.position.z - position.z, 2),
            );
            return dist < closest.dist ? { dist, block } : closest;
          },
          { dist: Infinity, block: oreBlocks[0] },
        );

        oreInfo.push(`${ore.replace('_ore', '')}矿(${oreBlocks.length}个, 最近: ${Math.floor(nearest.dist)}格)`);
      }
    }
    if (oreInfo.length > 0) {
      resources.push(`矿物: ${oreInfo.join(', ')}`);
    }

    // 树木资源
    const logTypes = Object.keys(groupedBlocks).filter(k => k.endsWith('_log'));
    if (logTypes.length > 0) {
      const totalLogs = logTypes.reduce((sum, type) => sum + groupedBlocks[type].length, 0);
      resources.push(`树木: ${totalLogs}个原木 (${logTypes.map(t => t.replace('_log', '')).join(', ')})`);
    }

    return { obstacles, structures, resources, environment };
  }

  /**
   * 分析视线方向的障碍物
   */
  private analyzeViewDirection(position: BlockPosition, blocks: BlockInfo[]): string | null {
    if (!this.bot) return null;

    const yaw = this.bot.entity.yaw || 0;
    const pitch = this.bot.entity.pitch || 0;

    // 计算视线方向
    const dirX = -Math.sin(yaw) * Math.cos(pitch);
    const dirY = -Math.sin(pitch);
    const dirZ = Math.cos(yaw) * Math.cos(pitch);

    // 在视线方向上检查障碍物（5格内）
    const solidBlocks = blocks.filter(b => !this.isNonSolid(b.name));
    const blocksInView = solidBlocks.filter(b => {
      const dx = b.position.x - position.x;
      const dy = b.position.y - position.y;
      const dz = b.position.z - position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 5) return false;

      // 计算方块是否在视线锥内（夹角<45度）
      const dot = (dx * dirX + dy * dirY + dz * dz) / dist;
      return dot > 0.7; // cos(45°) ≈ 0.707
    });

    if (blocksInView.length > 0) {
      const nearest = blocksInView.reduce(
        (closest, b) => {
          const dist = Math.sqrt(
            Math.pow(b.position.x - position.x, 2) + Math.pow(b.position.y - position.y, 2) + Math.pow(b.position.z - position.z, 2),
          );
          return dist < closest.dist ? { dist, block: b } : closest;
        },
        { dist: Infinity, block: blocksInView[0] },
      );

      const pitchDeg = Math.round((pitch * 180) / Math.PI);
      const direction = pitchDeg < -30 ? '上方' : pitchDeg > 30 ? '下方' : '前方';
      return `视线${direction}有障碍: ${nearest.block.name}, 距离${Math.floor(nearest.dist)}格`;
    }

    return null;
  }

  /**
   * 分析高度变化
   */
  private analyzeHeightVariation(position: BlockPosition, blocks: BlockInfo[]): string | null {
    // 统计不同高度的固体方块数量
    const heightMap = new Map<number, number>();
    blocks.forEach(b => {
      if (!this.isNonSolid(b.name)) {
        const count = heightMap.get(b.position.y) || 0;
        heightMap.set(b.position.y, count + 1);
      }
    });

    const heights = Array.from(heightMap.keys()).sort((a, b) => a - b);
    if (heights.length < 3) return null;

    const minY = heights[0];
    const maxY = heights[heights.length - 1];
    const rangeY = maxY - minY;

    if (rangeY > 20) {
      return `地形起伏大: 高度跨度${rangeY}格 (${minY}~${maxY})`;
    } else if (rangeY > 10) {
      return `地形起伏中等: 高度跨度${rangeY}格`;
    }

    return null;
  }

  /**
   * 分析障碍物簇（使用连通性）
   */
  private analyzeObstacleClusters(position: BlockPosition, groupedBlocks: Record<string, BlockInfo[]>): string[] {
    const result: string[] = [];

    // 检查是否被包围
    const solidBlocks = Object.entries(groupedBlocks)
      .filter(([name]) => !this.isNonSolid(name))
      .flatMap(([_, blocks]) => blocks);

    // 检查8个水平方向
    const directions = [
      { dx: 1, dz: 0, name: '东' },
      { dx: -1, dz: 0, name: '西' },
      { dx: 0, dz: 1, name: '南' },
      { dx: 0, dz: -1, name: '北' },
      { dx: 1, dz: 1, name: '东南' },
      { dx: -1, dz: 1, name: '西南' },
      { dx: 1, dz: -1, name: '东北' },
      { dx: -1, dz: -1, name: '西北' },
    ];

    const blockedDirs: string[] = [];
    for (const dir of directions) {
      // 检查该方向2格内是否有固体方块
      const blocked = solidBlocks.some(b => {
        const dx = b.position.x - position.x;
        const dz = b.position.z - position.z;
        const dy = Math.abs(b.position.y - position.y);
        // 同一高度或上下1格内
        if (dy > 1) return false;
        // 方向匹配且距离<3
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 3) return false;
        const dot = (dx * dir.dx + dz * dir.dz) / dist;
        return dot > 0.7;
      });
      if (blocked) {
        blockedDirs.push(dir.name);
      }
    }

    if (blockedDirs.length >= 6) {
      result.push(`周围较为封闭，受阻方向: ${blockedDirs.join('、')}`);
    } else if (blockedDirs.length >= 3) {
      result.push(`部分方向受阻: ${blockedDirs.join('、')}`);
    }

    return result;
  }

  /**
   * 判断是否为非固体方块
   */
  private isNonSolid(blockName: string): boolean {
    return ['air', 'cave_air', 'water', 'lava', 'grass', 'tall_grass', 'short_grass', 'seagrass', 'kelp', 'kelp_plant', 'torch', 'flower'].some(
      name => blockName.includes(name),
    );
  }

  /**
   * 按方块类型分组
   */
  private groupBlocksByType(blocks: BlockInfo[], centerPos: BlockPosition): Record<string, BlockInfo[]> {
    const grouped: Record<string, BlockInfo[]> = {};

    for (const block of blocks) {
      // 跳过普通空气（但保留cave_air，可能有用）
      if (block.name === 'air') {
        continue;
      }

      // 计算距离，用于排序
      const distance = Math.sqrt(
        Math.pow(block.position.x - centerPos.x, 2) + Math.pow(block.position.y - centerPos.y, 2) + Math.pow(block.position.z - centerPos.z, 2),
      );
      (block as any).distance = distance;

      if (!grouped[block.name]) {
        grouped[block.name] = [];
      }
      grouped[block.name].push(block);
    }

    return grouped;
  }

  /**
   * 格式化分组后的方块信息（精简版本，去除emoji）
   */
  private formatGroupedBlocks(groupedBlocks: Record<string, BlockInfo[]>): string[] {
    const lines: string[] = [];

    // 定义方块优先级（重要的方块优先显示）
    const priorityBlocks = [
      'water',
      'lava',
      'chest',
      'furnace',
      'crafting_table',
      'diamond_ore',
      'emerald_ore',
      'gold_ore',
      'iron_ore',
      'coal_ore',
      'redstone_ore',
      'lapis_ore',
      'copper_ore',
      'oak_log',
      'birch_log',
      'spruce_log',
    ];

    // 先显示优先级方块
    const displayedTypes = new Set<string>();
    for (const blockType of priorityBlocks) {
      if (groupedBlocks[blockType]) {
        const blocks = groupedBlocks[blockType];
        const coordStr = this.formatCoordinates(blocks);
        lines.push(`  ${blockType}(${blocks.length}): ${coordStr}`);
        displayedTypes.add(blockType);
      }
    }

    // 按数量排序显示其他常见方块
    const commonBlocks = ['stone', 'cobblestone', 'dirt', 'grass_block', 'andesite', 'granite', 'diorite', 'gravel', 'sand'];
    const otherCommon = Object.entries(groupedBlocks)
      .filter(([type]) => !displayedTypes.has(type) && commonBlocks.includes(type))
      .sort((a, b) => b[1].length - a[1].length);

    for (const [blockType, blocks] of otherCommon) {
      const coordStr = this.formatCoordinates(blocks);
      lines.push(`  ${blockType}(${blocks.length}): ${coordStr}`);
      displayedTypes.add(blockType);
    }

    // 显示其他方块（限制数量）
    const otherBlocks = Object.entries(groupedBlocks)
      .filter(([type]) => !displayedTypes.has(type))
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10);

    if (otherBlocks.length > 0) {
      const otherSummary = otherBlocks.map(([type, blocks]) => `${type}(${blocks.length})`).join(', ');
      lines.push(`  其他: ${otherSummary}`);
    }

    return lines;
  }

  /**
   * 格式化坐标列表（智能压缩，节省token）
   */
  private formatCoordinates(blocks: BlockInfo[]): string {
    if (blocks.length === 0) return '无';

    const sortedBlocks = blocks.sort((a, b) => (a as any).distance - (b as any).distance);

    // 如果方块很少，直接列出最近的坐标
    if (blocks.length <= 2) {
      return sortedBlocks.map(b => `(${b.position.x},${b.position.y},${b.position.z})`).join(',');
    }

    // 显示最近的1个 + 范围
    const nearest = sortedBlocks[0];
    const nearestStr = `最近(${nearest.position.x},${nearest.position.y},${nearest.position.z})`;

    // 计算范围（只显示有变化的维度）
    const xValues = blocks.map(b => b.position.x);
    const yValues = blocks.map(b => b.position.y);
    const zValues = blocks.map(b => b.position.z);

    const xMin = Math.min(...xValues);
    const xMax = Math.max(...xValues);
    const yMin = Math.min(...yValues);
    const yMax = Math.max(...yValues);
    const zMin = Math.min(...zValues);
    const zMax = Math.max(...zValues);

    const ranges: string[] = [];
    if (xMax - xMin > 2) ranges.push(`x:${xMin}~${xMax}`);
    if (yMax - yMin > 2) ranges.push(`y:${yMin}~${yMax}`);
    if (zMax - zMin > 2) ranges.push(`z:${zMin}~${zMax}`);

    if (ranges.length === 0) {
      return nearestStr;
    }

    return `${nearestStr}, ${ranges.join(',')}`;
  }

  /**
   * 获取可放置方块的位置
   */
  getPlaceablePositions(position: BlockPosition, distance: number = 5): string {
    try {
      const blocks = this.blockCache.getBlocksInRadius(position.x, position.y, position.z, distance);

      // 创建位置映射
      const blockMap = new Map<string, BlockInfo>();
      for (const block of blocks) {
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        blockMap.set(key, block);
      }

      const placeablePositions: BlockPosition[] = [];
      const waterPositions: BlockPosition[] = [];
      const lavaPositions: BlockPosition[] = [];

      // 6个相邻方向
      const directions = [
        [0, 1, 0], // 上
        [0, -1, 0], // 下
        [1, 0, 0], // 右
        [-1, 0, 0], // 左
        [0, 0, 1], // 前
        [0, 0, -1], // 后
      ];

      // 检查每个位置
      for (let x = position.x - distance; x <= position.x + distance; x++) {
        for (let y = position.y - distance; y <= position.y + distance; y++) {
          for (let z = position.z - distance; z <= position.z + distance; z++) {
            const currentKey = `${x},${y},${z}`;
            const currentBlock = blockMap.get(currentKey);

            if (!currentBlock) continue;

            // 只检查空气、水或岩浆位置
            if (!['air', 'cave_air', 'water', 'lava'].includes(currentBlock.name)) {
              continue;
            }

            // 计算相邻固体方块数量
            let solidCount = 0;
            for (const [dx, dy, dz] of directions) {
              const adjKey = `${x + dx},${y + dy},${z + dz}`;
              const adjBlock = blockMap.get(adjKey);
              if (adjBlock && !['air', 'cave_air', 'water', 'lava'].includes(adjBlock.name)) {
                solidCount++;
              }
            }

            // 需要至少1个相邻固体方块
            if (solidCount >= 1 && solidCount <= 5) {
              if (currentBlock.name === 'air' || currentBlock.name === 'cave_air') {
                placeablePositions.push({ x, y, z });
              } else if (currentBlock.name === 'water') {
                waterPositions.push({ x, y, z });
              } else if (currentBlock.name === 'lava') {
                lavaPositions.push({ x, y, z });
              }
            }
          }
        }
      }

      const lines: string[] = [];
      if (placeablePositions.length > 0) {
        const coordStr = this.formatSimpleCoordinates(placeablePositions);
        lines.push(`可直接放置: ${coordStr}`);
      }
      if (waterPositions.length > 0) {
        const coordStr = this.formatSimpleCoordinates(waterPositions);
        lines.push(`可放置(会替换水): ${coordStr}`);
      }
      if (lavaPositions.length > 0) {
        const coordStr = this.formatSimpleCoordinates(lavaPositions);
        lines.push(`可放置(会替换岩浆): ${coordStr}`);
      }

      return lines.length > 0 ? lines.join('\n') : '附近没有合适的放置位置';
    } catch (error) {
      this.logger.error('获取可放置位置失败', undefined, error as Error);
      return '获取可放置位置失败';
    }
  }

  /**
   * 格式化简单坐标列表
   */
  private formatSimpleCoordinates(positions: BlockPosition[]): string {
    if (positions.length === 0) return '无';
    if (positions.length <= 5) {
      return positions.map(p => `(${p.x},${p.y},${p.z})`).join(', ');
    }

    // 显示前5个
    const shown = positions.slice(0, 5);
    const shownStr = shown.map(p => `(${p.x},${p.y},${p.z})`).join(', ');
    return `${shownStr} 等${positions.length}个位置`;
  }
}
