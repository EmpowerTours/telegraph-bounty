// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LegacyToken
/// @notice Wrapped-ether token in the style of early ERC-20s: 1 token per wei deposited.
/// Like several tokens still in use, transfer() and transferFrom() report failure by
/// returning false instead of reverting.
contract LegacyToken {
    string public constant name = "Legacy Wrapped Ether";
    string public constant symbol = "LWETH";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        emit Transfer(msg.sender, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (balanceOf[from] < amount || allowance[from][msg.sender] < amount) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @title TokenVault
/// @notice Demo bounty target written for this repo only. It contains a deliberate bug.
/// Never deploy it with real funds.
/// Custodies LegacyToken for its users. The vault deploys its own token at construction.
contract TokenVault {
    LegacyToken public immutable token;
    mapping(address => uint256) public balances;
    uint256 public totalDeposits;

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    constructor() {
        token = new LegacyToken();
    }

    /// @notice Pulls `amount` tokens from the caller (approve the vault first).
    function deposit(uint256 amount) external {
        require(amount > 0, "zero deposit");
        token.transferFrom(msg.sender, address(this), amount);
        balances[msg.sender] += amount;
        totalDeposits += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient balance");
        balances[msg.sender] -= amount;
        totalDeposits -= amount;
        require(token.transfer(msg.sender, amount), "token transfer failed");
        emit Withdrawn(msg.sender, amount);
    }
}
