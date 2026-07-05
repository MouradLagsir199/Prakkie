import type { ChainConnector } from './types';
import { ahConnector } from './ah';
import { aldiConnector } from './aldi';
import { detailresultConnector } from './detailresult';
import { jumboConnector } from './jumbo';
import { plusConnector } from './plus';
import { sparConnector } from './spar';

/**
 * chain id → connector (catalog.chains.connector names the connector; the
 * detailresult connector serves both dirk and dekamarkt). vomar / hoogvliet /
 * ekoplaza land when their scrapers exist; picnic stays kill-switched
 * (owner decision #7).
 */
export const CONNECTORS: Record<string, ChainConnector> = {
  ah: ahConnector,
  jumbo: jumboConnector,
  plus: plusConnector,
  dirk: detailresultConnector,
  dekamarkt: detailresultConnector,
  aldi: aldiConnector,
  spar: sparConnector,
};

export function connectorFor(chainId: string): ChainConnector | undefined {
  return CONNECTORS[chainId];
}
