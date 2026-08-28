import { PromiseScheduler } from '~/common/utils/promise-scheduler'
import { CompletedSubBatch, StreamIngestDriver, SubBatchBudget } from '~/ingestion/api/grpc-server'
import { deserializeKafkaMessage } from '~/ingestion/api/kafka-message-converter'
import { SerializedKafkaMessage } from '~/ingestion/api/types'
import { BatchBudget, BatchBudgetFactory, budgetDeadline } from '~/ingestion/framework/batch-budget'
import { FeedResult } from '~/ingestion/framework/batching-pipeline'
import { createKafkaDebugContext, createOkContext } from '~/ingestion/framework/helpers'
import {
    JoinedIngestionPipelineContext,
    JoinedIngestionPipelineInput,
    createJoinedIngestionPipeline,
} from '~/ingestion/pipelines/analytics/joined-ingestion-pipeline'

/**
 * Batch context fed with each gRPC sub-batch: the stream coordinates that route
 * its completion back to the right stream, plus the armed wire allowance the
 * budget factory turns into a deadline.
 */
export type GrpcBatchContext = { grpcStreamId: number; grpcSeq: number } & SubBatchBudget

/**
 * Mints each sub-batch's budget from what the consumer sent, and nothing else.
 * `enforce` is the worker's rollout gate: in shadow mode the checkpoints count
 * what they would have cut off and every result stays as it is.
 */
export function createWireBudgetFactory(enforce: boolean): BatchBudgetFactory<GrpcBatchContext> {
    return ({ armedAt, softBudgetMs }) =>
        BatchBudget.softDeadline(budgetDeadline(armedAt, softBudgetMs) ?? Infinity, { enforce })
}

export type GrpcIngestPipeline = ReturnType<
    typeof createJoinedIngestionPipeline<JoinedIngestionPipelineInput, JoinedIngestionPipelineContext, GrpcBatchContext>
>

/**
 * Pipeline mechanics for the gRPC stream server. The `settled` promise on
 * each completed batch is the ack barrier: it mirrors the HTTP handler's
 * contract (side effects plus the promise scheduler) but stays a promise
 * so the server can settle many batches concurrently.
 */
export class GrpcStreamIngestDriver implements StreamIngestDriver {
    constructor(
        private pipeline: GrpcIngestPipeline,
        private promiseScheduler: PromiseScheduler
    ) {}

    feed(
        streamId: number,
        seq: number,
        messages: SerializedKafkaMessage[],
        budget: SubBatchBudget
    ): Promise<FeedResult> {
        const batch = messages.map((serialized) => {
            const message = deserializeKafkaMessage(serialized)
            return createOkContext({ message }, { message, debugContext: createKafkaDebugContext(message) })
        })
        return this.pipeline.feed(batch, { grpcStreamId: streamId, grpcSeq: seq, ...budget })
    }

    async next(): Promise<CompletedSubBatch | null> {
        const result = await this.pipeline.next()
        if (result === null) {
            return null
        }
        // waitForAll snapshots the currently scheduled promises, so this
        // settles even under sustained load from other batches.
        const settled = (async (): Promise<void> => {
            await Promise.all(result.sideEffects ?? [])
            await this.promiseScheduler.waitForAll()
        })()
        return {
            streamId: result.batchContext.grpcStreamId,
            seq: result.batchContext.grpcSeq,
            accepted: result.elements.length,
            settled,
        }
    }
}
