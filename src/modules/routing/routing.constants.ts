export const CLAIM_BEST_AGENT_LUA = `
local skillZsetKey = KEYS[1]
local tenantId = ARGV[1]
local skillTag = ARGV[2]

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

    if status == 'ONLINE' and currentLoad < maxCapacity then
        local newLoad = redis.call('INCR', loadKey)

        local profStr = redis.call('HGET', infoKey, 'prof:' .. skillTag)
        local prof = tonumber(profStr) or 1

        if newLoad >= maxCapacity then
            redis.call('ZREM', skillZsetKey, agentId)
        else
            local availableRatio = (maxCapacity - newLoad) / maxCapacity
            local newScore = (prof * 100) + (availableRatio * 50)
            redis.call('ZADD', skillZsetKey, newScore, agentId)
        end

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

        return agentId
    elseif currentLoad >= maxCapacity or status ~= 'ONLINE' then
        redis.call('ZREM', skillZsetKey, agentId)
    end
end

return nil
`;

export const FREE_AGENT_CAPACITY_LUA = `
local loadKey = KEYS[1]
local infoKey = KEYS[2]
local tenantId = ARGV[1]
local agentId = ARGV[2]

local currentLoad = tonumber(redis.call('GET', loadKey)) or 0
local newLoad = currentLoad - 1
if newLoad < 0 then
    newLoad = 0
end
redis.call('SET', loadKey, newLoad)

local status = redis.call('HGET', infoKey, 'status')
local maxCapacityStr = redis.call('HGET', infoKey, 'max_capacity')
local maxCapacity = tonumber(maxCapacityStr) or 5

if status == 'ONLINE' then
    local allSkillsStr = redis.call('HGET', infoKey, 'all_skills')
    if allSkillsStr then
        for s in string.gmatch(allSkillsStr, "([^,]+)") do
            local zsetKey = 'tenant:' .. tenantId .. ':skill:' .. s .. ':agents'
            local profStr = redis.call('HGET', infoKey, 'prof:' .. s)
            local prof = tonumber(profStr) or 1
            local availableRatio = (maxCapacity - newLoad) / maxCapacity
            local score = (prof * 100) + (availableRatio * 50)
            redis.call('ZADD', zsetKey, score, agentId)
        end
    end
end

return newLoad
`;

export const getSkillZsetKey = (tenantId: string, skill: string): string =>
  `tenant:${tenantId}:skill:${skill}:agents`;

export const getAgentLoadKey = (tenantId: string, agentId: string): string =>
  `tenant:${tenantId}:agent:${agentId}:load`;

export const getAgentInfoKey = (tenantId: string, agentId: string): string =>
  `tenant:${tenantId}:agent:${agentId}:info`;

export const getTenantOverflowKey = (tenantId: string): string =>
  `tenant:${tenantId}:routing:overflow`;
