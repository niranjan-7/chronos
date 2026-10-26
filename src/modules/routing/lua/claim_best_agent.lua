--[[
  claim_best_agent.lua
  Atomically inspects candidate agents in a skill ZSET from highest composite score to lowest,
  verifies the candidate is ONLINE and active_load < max_capacity,
  increments active_load, recalculates composite score across all agent skill ZSETs,
  and returns the winning agentId in a single round-trip with zero race conditions.

  KEYS[1]: skill ZSET key (e.g. tenant:{tenantId}:skill:{skillTag}:agents)
  ARGV[1]: tenantId
  ARGV[2]: skillTag
--]]

local skillZsetKey = KEYS[1]
local tenantId = ARGV[1]
local skillTag = ARGV[2]

-- 1. Inspect candidate agents in the required skill ZSET from highest score to lowest
local candidates = redis.call('ZREVRANGE', skillZsetKey, 0, -1)

if not candidates or #candidates == 0 then
    return nil
end

for _, agentId in ipairs(candidates) do
    local infoKey = 'tenant:' .. tenantId .. ':agent:' .. agentId .. ':info'
    local loadKey = 'tenant:' .. tenantId .. ':agent:' .. agentId .. ':load'

    local status = redis.call('HGET', infoKey, 'status')
    local maxCapacityStr = redis.call('HGET', infoKey, 'max_capacity')
    local maxCapacity = tonumber(maxCapacityStr) or 5
    local currentLoad = tonumber(redis.call('GET', loadKey)) or 0

    -- 2. Verify candidate is ONLINE and active_load < max_capacity
    if status == 'ONLINE' and currentLoad < maxCapacity then
        -- 3. Atomically increment their active_load
        local newLoad = redis.call('INCR', loadKey)

        -- Recalculate candidate's composite score for this skill ZSET
        local profStr = redis.call('HGET', infoKey, 'prof:' .. skillTag)
        local prof = tonumber(profStr) or 1

        if newLoad >= maxCapacity then
            -- At 100% capacity: remove from ZSET so agent cannot be selected
            redis.call('ZREM', skillZsetKey, agentId)
        else
            local availableRatio = (maxCapacity - newLoad) / maxCapacity
            local newScore = (prof * 100) + (availableRatio * 50)
            redis.call('ZADD', skillZsetKey, newScore, agentId)
        end

        -- Update agent's composite score across all other registered skill ZSETs
        local allSkillsStr = redis.call('HGET', infoKey, 'all_skills')
        if allSkillsStr then
            for s in string.gmatch(allSkillsStr, "([^,]+)") do
                if s ~= skillTag then
                    local otherZset = 'tenant:' .. tenantId .. ':skill:' .. s .. ':agents'
                    local otherProf = tonumber(redis.call('HGET', infoKey, 'prof:' .. s)) or 1
                    if newLoad >= maxCapacity then
                        redis.call('ZREM', otherZset, agentId)
                    else
                        local otherRatio = (maxCapacity - newLoad) / maxCapacity
                        local otherScore = (otherProf * 100) + (otherRatio * 50)
                        redis.call('ZADD', otherZset, otherScore, agentId)
                    end
                end
            end
        end

        -- Return winning agentId
        return agentId
    elseif currentLoad >= maxCapacity or status ~= 'ONLINE' then
        -- Clean up candidate from ZSET if at capacity or offline
        redis.call('ZREM', skillZsetKey, agentId)
    end
end

return nil
